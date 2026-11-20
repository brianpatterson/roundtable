import { Context, Duration, Effect, ErrorReporter, Layer, Redacted, Schema } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';
import type { Log } from '../../platform/observability/logging.js';

/** An issue to open. Built by the support handler from safe context only (ADR-0037). */
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
 * Opens GitHub issues for problem reports: GitHub's REST API, `skipped` when no token is set
 * (development, tests), or a test's capture. `undefined` means the issue was skipped.
 */
export class GitHubIssues extends Context.Service<
  GitHubIssues,
  { readonly open: (issue: NewIssue) => Effect.Effect<OpenedIssue | undefined, IssueOpenFailed> }
>()('roundtable/GitHubIssues') {
  /** No token: logs that the issue wasn't opened, and opens nothing. */
  static readonly skipped = (log: Pick<Log, 'info'>) =>
    Layer.succeed(GitHubIssues, {
      open: (issue) =>
        Effect.sync(() => {
          log.info({ title: issue.title }, 'GitHub issue skipped: GITHUB_ISSUES_TOKEN is not set');

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

export interface GitHubIssuesOptions {
  /** Fine-grained token: this repository only, Issues read/write. */
  readonly token: Redacted.Redacted<string>;
  /** `owner/name`. */
  readonly repository: string;
}

/** GitHub's answer to a created issue; only the link is used. */
const CreatedIssue = Schema.Struct({ html_url: Schema.String });

/** The user waits for this before seeing the confirmation, so it gives up rather than hang. */
const TIMEOUT = Duration.seconds(10);

/**
 * One POST to https://docs.github.com/rest/issues/issues#create-an-issue, no SDK and no retries
 * (the ticket leaves retrying out: a failure is reported and the report is still stored).
 */
export const makeGitHubIssues = Effect.fnUntraced(function* (options: GitHubIssuesOptions) {
  const client = yield* HttpClient.HttpClient;
  const url = `https://api.github.com/repos/${options.repository}/issues`;

  return GitHubIssues.of({
    open: Effect.fn('GitHubIssues.open')(function* (issue: NewIssue) {
      const res = yield* HttpClientRequest.post(url).pipe(
        HttpClientRequest.bearerToken(options.token),
        HttpClientRequest.setHeaders({
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          // GitHub rejects requests without one.
          'user-agent': 'roundtable-api',
        }),
        HttpClientRequest.bodyJsonUnsafe(issue),
        client.execute,
        Effect.timeoutOrElse({
          duration: TIMEOUT,
          orElse: () => Effect.fail(new IssueOpenFailed({ message: 'GitHub timed out' })),
        }),
        Effect.catchTag('HttpClientError', (error) =>
          Effect.fail(new IssueOpenFailed({ message: `GitHub unreachable: ${error.message}` })),
        ),
      );

      const body = yield* res.text.pipe(Effect.orElseSucceed(() => ''));

      if (res.status >= 300) {
        return yield* new IssueOpenFailed({
          status: res.status,
          message: `GitHub refused the issue (HTTP ${res.status}): ${body.slice(0, 500)}`,
        });
      }

      const created = yield* Schema.decodeEffect(Schema.fromJsonString(CreatedIssue))(body).pipe(
        Effect.mapError(
          () =>
            new IssueOpenFailed({ status: res.status, message: 'Unexpected answer from GitHub' }),
        ),
      );

      return { url: created.html_url };
    }),
  });
});

/** GitHub over fetch. */
export const gitHubIssuesLayer = (options: GitHubIssuesOptions) =>
  Layer.effect(GitHubIssues, makeGitHubIssues(options)).pipe(Layer.provide(FetchHttpClient.layer));
