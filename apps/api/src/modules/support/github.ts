import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { Clock, Context, Duration, Effect, ErrorReporter, Layer, Redacted, Schema } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';
import type { Log } from '../../platform/observability/logging.js';

/** An issue to open. Built by the support handler from safe context only (ADR-0038). */
export interface NewIssue {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

export interface OpenedIssue {
  readonly url: string;
}

/**
 * GitHub refused the issue or never answered. `status` is GitHub's, for triage; nothing here
 * comes from the user.
 */
export class IssueOpenFailed extends Schema.TaggedError<
  IssueOpenFailed,
  { readonly brand: unique symbol }
>()('IssueOpenFailed', {
  status: Schema.optional(Schema.Int),
  message: Schema.String,
}) {
  get [ErrorReporter.attributes]() {
    return { source: 'github-issues', status: this.status };
  }
}

/**
 * The configured GitHub App private key isn't a PEM key (malformed, or cut short). Building the
 * GitHub client fails with it, so the API doesn't start and the deploy rolls back (ADR-0014).
 * It names the variable, never the key or the parser's message, which can quote it.
 */
export class GitHubAppKeyInvalid extends Schema.TaggedError<
  GitHubAppKeyInvalid,
  { readonly brand: unique symbol }
>()('GitHubAppKeyInvalid', {
  message: Schema.String,
}) {}

/**
 * Opens GitHub issues for problem reports: GitHub's REST API as a GitHub App, `skipped` when none is configured
 * (development, tests), or a test's capture. `undefined` means the issue was skipped.
 */
export class GitHubIssues extends Context.Service<
  GitHubIssues,
  { readonly open: (issue: NewIssue) => Effect.Effect<OpenedIssue | undefined, IssueOpenFailed> }
>()('roundtable/GitHubIssues') {
  /** No GitHub App configured: logs that the issue wasn't opened, and opens nothing. */
  static readonly skipped = (log: Pick<Log, 'info'>) =>
    Layer.succeed(GitHubIssues, {
      open: (issue) =>
        Effect.sync(() => {
          log.info({ title: issue.title }, 'GitHub issue skipped: no GitHub App is configured');

          return undefined;
        }),
    });

  /** From a Promise-returning function (tests capture issues, or fail, with one). */
  static readonly fromPromise = (open: (issue: NewIssue) => Promise<OpenedIssue>) =>
    Layer.succeed(GitHubIssues, {
      open: (issue) =>
        Effect.tryPromise({
          try: () => open(issue),
          catch: (error) =>
            new IssueOpenFailed({
              message: error instanceof Error ? error.message : 'Opening the issue failed',
            }),
        }),
    });
}

/**
 * A GitHub App installed on the repository with Issues read/write only (ADR-0038). Its issues are
 * authored by `<app>[bot]`, never the owner, so a leaked key can't act as the owner, whom the
 * factory trusts (ADR-0025).
 */
export interface GitHubIssuesOptions {
  readonly appId: string;
  readonly installationId: string;
  /** The App's private key, PEM. `\n` escapes count as newlines (a one-line `.env` value). */
  readonly privateKey: Redacted.Redacted<string>;
  /** `owner/name`. */
  readonly repository: string;
}

/** GitHub's answer to an installation token request; only the token is used. */
const InstallationToken = Schema.Struct({ token: Schema.String });

/** GitHub's answer to a created issue; only the link is used. */
const CreatedIssue = Schema.Struct({ html_url: Schema.String });

/** The user waits for this before seeing the confirmation, so it gives up rather than hang. */
const TIMEOUT = Duration.seconds(10);

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/**
 * The App's own JWT (RS256), valid for 9 minutes from a minute ago (GitHub allows 10 and some
 * clock drift): https://docs.github.com/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
 */
export function appJwt(appId: string, privateKey: KeyObject, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));

  const payload = base64url(
    JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }),
  );

  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), privateKey);

  return `${header}.${payload}.${base64url(signature)}`;
}

const GITHUB_HEADERS = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  // GitHub rejects requests without one.
  'user-agent': 'roundtable-api',
};

/**
 * Per issue: a short-lived installation token, narrowed to this repository and Issues: write,
 * then one POST to https://docs.github.com/rest/issues/issues#create-an-issue with it. No SDK and
 * no retries (the ticket leaves retrying out: a failure is reported and the report is still
 * stored). At most `REPORT_LIMIT_PER_DAY` issues a day, so the token isn't cached. The private
 * key is parsed once, when the client is built: an invalid one fails with GitHubAppKeyInvalid,
 * which stops the API from starting.
 */
export const makeGitHubIssues = Effect.fnUntraced(function* (options: GitHubIssuesOptions) {
  const client = yield* HttpClient.HttpClient;
  const [, repositoryName] = options.repository.split('/');
  const tokenUrl = `https://api.github.com/app/installations/${options.installationId}/access_tokens`;
  const issuesUrl = `https://api.github.com/repos/${options.repository}/issues`;

  // Parsed once, here: a bad key fails the client's construction (startup), not each report.
  const key = yield* Effect.try({
    try: () => createPrivateKey(Redacted.value(options.privateKey).replaceAll('\\n', '\n')),
    // Never the key or the parser's message, which can quote it.
    catch: () =>
      new GitHubAppKeyInvalid({
        message: 'GITHUB_ISSUES_PRIVATE_KEY: the GitHub App private key is invalid',
      }),
  });

  /** Sends one request; a failure carries GitHub's status and its answer, never the request. */
  const call = Effect.fnUntraced(function* (
    what: string,
    request: HttpClientRequest.HttpClientRequest,
  ) {
    const res = yield* client
      .execute(request)
      .pipe(
        Effect.catchTag('HttpClientError', (error) =>
          Effect.fail(new IssueOpenFailed({ message: `GitHub unreachable: ${error.message}` })),
        ),
      );

    const body = yield* res.text.pipe(Effect.orElseSucceed(() => ''));

    if (res.status >= 300) {
      return yield* new IssueOpenFailed({
        status: res.status,
        message: `GitHub refused ${what} (HTTP ${res.status}): ${body.slice(0, 500)}`,
      });
    }

    return { status: res.status, body };
  });

  const decode =
    <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
    (answer: { status: number; body: string }) =>
      Schema.decodeEffect(Schema.fromJsonString(schema))(answer.body).pipe(
        Effect.mapError(
          () =>
            new IssueOpenFailed({
              status: answer.status,
              message: 'Unexpected answer from GitHub',
            }),
        ),
      );

  const installationToken = Effect.fnUntraced(function* () {
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);

    const answer = yield* call(
      'the installation token',
      HttpClientRequest.post(tokenUrl).pipe(
        HttpClientRequest.bearerToken(appJwt(options.appId, key, now)),
        HttpClientRequest.setHeaders(GITHUB_HEADERS),
        HttpClientRequest.bodyJsonUnsafe({
          repositories: [repositoryName],
          permissions: { issues: 'write' },
        }),
      ),
    );

    return Redacted.make((yield* decode(InstallationToken)(answer)).token);
  });

  return GitHubIssues.of({
    open: Effect.fn('GitHubIssues.open')(function* (issue: NewIssue) {
      return yield* Effect.gen(function* () {
        const token = yield* installationToken();

        const answer = yield* call(
          'the issue',
          HttpClientRequest.post(issuesUrl).pipe(
            HttpClientRequest.bearerToken(token),
            HttpClientRequest.setHeaders(GITHUB_HEADERS),
            HttpClientRequest.bodyJsonUnsafe(issue),
          ),
        );

        const created = yield* decode(CreatedIssue)(answer);

        return { url: created.html_url };
      }).pipe(
        Effect.timeoutOrElse({
          duration: TIMEOUT,
          orElse: () => Effect.fail(new IssueOpenFailed({ message: 'GitHub timed out' })),
        }),
      );
    }),
  });
});

/** GitHub over fetch. */
export const gitHubIssuesLayer = (options: GitHubIssuesOptions) =>
  Layer.effect(GitHubIssues, makeGitHubIssues(options)).pipe(Layer.provide(FetchHttpClient.layer));
