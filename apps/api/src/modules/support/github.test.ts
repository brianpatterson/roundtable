// The GitHub issues client against a scripted fetch: what it sends, and how it fails.
import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { it as itEffect } from '@effect/vitest';
import { Cause, Effect, ErrorReporter, Exit, Fiber, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { TestClock } from 'effect/testing';
import {
  GitHubAppKeyInvalid,
  GitHubIssues,
  IssueOpenFailed,
  appJwt,
  makeGitHubIssues,
  type NewIssue,
} from './github.js';

const issue: NewIssue = {
  title: 'User report 1: /',
  body: 'Safe context',
  labels: ['bug', 'user-report'],
};

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const TOKEN_URL = 'https://api.github.com/app/installations/42/access_tokens';
const ISSUES_URL = 'https://api.github.com/repos/owner/repo/issues';

interface Sent {
  readonly url: string;
  readonly headers: Headers;
  readonly body: unknown;
}

const tokenAnswer = () => Response.json({ token: 'ghs_installation' }, { status: 201 });

const issueAnswer = () =>
  Response.json({ number: 7, html_url: 'https://github.com/owner/repo/issues/7' }, { status: 201 });

function scriptedFetch(answers: {
  token?: () => Response | Promise<Response>;
  issue?: () => Response | Promise<Response>;
}) {
  const sent: Sent[] = [];

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);

    sent.push({
      url: request.url,
      headers: request.headers,
      body: Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(await request.text()),
    });

    return request.url === TOKEN_URL
      ? (answers.token ?? tokenAnswer)()
      : (answers.issue ?? issueAnswer)();
  };

  return { fetch, sent };
}

const options = (key: string) => ({
  appId: '123',
  installationId: '42',
  privateKey: Redacted.make(key),
  repository: 'owner/repo',
});

const build = (fetch: typeof globalThis.fetch, key: string) =>
  Effect.runPromiseExit(
    makeGitHubIssues(options(key)).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ),
  );

const open = (fetch: typeof globalThis.fetch, key = pem) =>
  Effect.runPromiseExit(
    makeGitHubIssues(options(key)).pipe(
      Effect.flatMap((issues) => issues.open(issue)),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ),
  );

const failureOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

const decodeSegment = (segment: string | undefined) =>
  Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(
    Buffer.from(segment ?? '', 'base64url').toString(),
  );

describe('GitHub issues client', () => {
  it('gets an installation token for this repository and Issues only, then posts the issue with it', async () => {
    const { fetch, sent } = scriptedFetch({});

    expect(await open(fetch)).toEqual(
      Exit.succeed({ url: 'https://github.com/owner/repo/issues/7' }),
    );
    expect(sent.map((request) => request.url)).toEqual([TOKEN_URL, ISSUES_URL]);

    const [tokenRequest, issueRequest] = sent;

    // The App authenticates with its own JWT, and narrows the token it gets.
    expect(tokenRequest?.headers.get('authorization')).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(tokenRequest?.body).toEqual({
      repositories: ['repo'],
      permissions: { issues: 'write' },
    });

    expect(issueRequest?.headers.get('authorization')).toBe('Bearer ghs_installation');
    expect(issueRequest?.headers.get('accept')).toBe('application/vnd.github+json');
    expect(issueRequest?.headers.get('user-agent')).toBe('roundtable-api');
    expect(issueRequest?.headers.get('x-github-api-version')).toBe('2022-11-28');
    expect(issueRequest?.body).toEqual(issue);
  });

  it('signs the token request with a JWT issued now, in seconds', async () => {
    const { fetch, sent } = scriptedFetch({});
    const before = Math.floor(Date.now() / 1000);

    await open(fetch);

    const jwt = sent[0]?.headers.get('authorization')?.replace('Bearer ', '') ?? '';

    const payload = Schema.decodeUnknownSync(Schema.Struct({ iat: Schema.Finite }))(
      decodeSegment(jwt.split('.')[1]),
    );

    // Issued a minute in the past, to allow for clock drift.
    expect(payload.iat).toBeGreaterThanOrEqual(before - 60);
    expect(payload.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) - 60);
  });

  it('signs a JWT GitHub accepts: RS256, issued by the App, expiring within 10 minutes', () => {
    const jwt = appJwt('123', privateKey, 1_000_000);
    const [header, payload, signature] = jwt.split('.');

    expect(decodeSegment(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decodeSegment(payload)).toEqual({ iat: 999_940, exp: 1_000_540, iss: '123' });
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature ?? '', 'base64url'),
      ),
    ).toBe(true);
  });

  it('accepts the private key on one line, with its newlines written as \\n', async () => {
    const { fetch } = scriptedFetch({});

    expect(Exit.isSuccess(await open(fetch, pem.replaceAll('\n', '\\n')))).toBe(true);
  });

  it.each([
    ['malformed', 'not-a-key-secret-material'],
    ['truncated partway through', pem.slice(0, pem.length / 2)],
  ])(
    'fails to build, without sending anything or quoting the key, when the key is %s',
    async (_, key) => {
      const { fetch, sent } = scriptedFetch({});
      const exit = await build(fetch, key);
      const failure = failureOf(exit);

      expect(failure).toBeInstanceOf(GitHubAppKeyInvalid);
      expect(failure).toMatchObject({
        message: expect.stringMatching(/GITHUB_ISSUES_PRIVATE_KEY.*invalid/),
      });

      const shown = `${JSON.stringify(failure)} ${String(failure)} ${Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ''}`;

      expect(shown).not.toContain('secret-material');

      // No line of the key, beyond the PEM header every key shares.
      for (const line of key.split('\n').slice(1).filter(Boolean)) {
        expect(shown).not.toContain(line);
      }

      expect(sent).toHaveLength(0);
    },
  );

  it('parses the key once, when built, and reuses it for every issue', async () => {
    const { fetch, sent } = scriptedFetch({});
    const settings = options(pem);

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const issues = yield* makeGitHubIssues(settings);

        // From here, reading the key's text throws: only the key parsed at build time can sign.
        Redacted.wipeUnsafe(settings.privateKey);

        const first = yield* issues.open(issue);
        const second = yield* issues.open(issue);

        return [first, second];
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      ),
    );

    const opened = { url: 'https://github.com/owner/repo/issues/7' };

    expect(exit).toEqual(Exit.succeed([opened, opened]));
    expect(sent.map((request) => request.url)).toEqual([
      TOKEN_URL,
      ISSUES_URL,
      TOKEN_URL,
      ISSUES_URL,
    ]);
  });

  it('fails with GitHub’s status when it refuses the token or the issue, without retrying', async () => {
    const token = scriptedFetch({
      token: () => Response.json({ message: 'Bad credentials' }, { status: 401 }),
    });

    const refusedToken = failureOf(await open(token.fetch));

    expect(refusedToken).toBeInstanceOf(IssueOpenFailed);
    expect(refusedToken).toMatchObject({
      status: 401,
      message: expect.stringContaining('Bad credentials'),
    });
    expect(token.sent).toHaveLength(1);

    const issueRefused = scriptedFetch({
      issue: () => Response.json({ message: 'Validation Failed' }, { status: 422 }),
    });

    expect(failureOf(await open(issueRefused.fetch))).toMatchObject({
      status: 422,
      message: expect.stringContaining('Validation Failed'),
    });
    expect(issueRefused.sent).toHaveLength(2);
  });

  it('fails when GitHub cannot be reached or answers something unexpected', async () => {
    const unreachable = failureOf(
      await open(
        scriptedFetch({ token: () => Promise.reject(new TypeError('fetch failed')) }).fetch,
      ),
    );

    const garbledToken = failureOf(
      await open(scriptedFetch({ token: () => new Response('<html>') }).fetch),
    );

    const garbledIssue = failureOf(
      await open(scriptedFetch({ issue: () => new Response('<html>') }).fetch),
    );

    expect(unreachable).toBeInstanceOf(IssueOpenFailed);
    expect(unreachable).toMatchObject({ message: expect.stringMatching(/^GitHub unreachable/) });
    expect(garbledToken).toMatchObject({ message: 'Unexpected answer from GitHub' });
    expect(garbledIssue).toMatchObject({ message: 'Unexpected answer from GitHub' });
  });

  it('names which request GitHub refused', async () => {
    const refused = () => Response.json({ message: 'Server Error' }, { status: 500 });

    expect(failureOf(await open(scriptedFetch({ token: refused }).fetch))).toMatchObject({
      message: expect.stringMatching(/^GitHub refused the installation token \(HTTP 500\)/),
    });
    expect(failureOf(await open(scriptedFetch({ issue: refused }).fetch))).toMatchObject({
      message: expect.stringMatching(/^GitHub refused the issue \(HTTP 500\)/),
    });
  });

  it('treats a 3xx answer as a refusal, not a success', async () => {
    const { fetch, sent } = scriptedFetch({
      token: () => Response.json({ token: 'ghs_installation' }, { status: 300 }),
    });

    expect(failureOf(await open(fetch))).toMatchObject({ status: 300 });
    expect(sent).toHaveLength(1);
  });

  it('quotes at most the first 500 characters of a refusal', async () => {
    const long = `${'a'.repeat(500)}${'z'.repeat(1500)}`;

    const failure = failureOf(
      await open(scriptedFetch({ token: () => new Response(long, { status: 500 }) }).fetch),
    );

    expect(failure).toMatchObject({ message: expect.stringContaining('a'.repeat(500)) });
    expect(failure).toMatchObject({ message: expect.not.stringContaining('z') });
  });

  it('still fails with GitHub’s status when its answer cannot be read', async () => {
    const unreadable = () =>
      new Response(
        new ReadableStream({
          pull: (controller) => controller.error(new Error('connection reset')),
        }),
        { status: 502 },
      );

    const failure = failureOf(await open(scriptedFetch({ token: unreadable }).fetch));

    expect(failure).toBeInstanceOf(IssueOpenFailed);
    expect(failure).toMatchObject({
      status: 502,
      message: 'GitHub refused the installation token (HTTP 502): ',
    });
  });

  it.each([
    ['the token', { token: () => Response.json({ expires_at: '2026-01-01' }, { status: 201 }) }],
    ['the issue', { issue: () => Response.json({ number: 7 }, { status: 201 }) }],
  ])('fails when GitHub’s answer to %s lacks what is used from it', async (_, answers) => {
    expect(failureOf(await open(scriptedFetch(answers).fetch))).toMatchObject({
      message: 'Unexpected answer from GitHub',
    });
  });

  it('fails with errors callers can handle by tag', async () => {
    const recovered = await Effect.runPromise(
      makeGitHubIssues(options(pem)).pipe(
        Effect.flatMap((issues) => issues.open(issue)),
        Effect.as('opened'),
        Effect.catchTag('IssueOpenFailed', () => Effect.succeed('issue failed')),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(
          FetchHttpClient.Fetch,
          scriptedFetch({ token: () => new Response('', { status: 401 }) }).fetch,
        ),
      ),
    );

    const badKey = await Effect.runPromise(
      makeGitHubIssues(options('not-a-key')).pipe(
        Effect.as('built'),
        Effect.catchTag('GitHubAppKeyInvalid', () => Effect.succeed('key invalid')),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, scriptedFetch({}).fetch),
      ),
    );

    expect([recovered, badKey]).toEqual(['issue failed', 'key invalid']);
  });

  itEffect.effect('gives up after 10 seconds without an answer', () =>
    Effect.gen(function* () {
      // Answers nothing until the request is abandoned.
      const silent: typeof globalThis.fetch = (_, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });

      const opening = yield* makeGitHubIssues(options(pem)).pipe(
        Effect.flatMap((issues) => issues.open(issue)),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, silent),
        Effect.exit,
        Effect.forkChild,
      );

      yield* TestClock.adjust('10 seconds');

      const failure = failureOf(yield* Fiber.join(opening));

      expect(failure).toBeInstanceOf(IssueOpenFailed);
      expect(failure).toMatchObject({ message: expect.stringMatching(/timed out/) });
    }),
  );

  it('fails with a message when a test’s capture rejects with something other than an Error', async () => {
    const exit = await Effect.runPromiseExit(
      GitHubIssues.use((issues) => issues.open(issue)).pipe(
        Effect.provide(GitHubIssues.fromPromise(() => Promise.reject('not an Error'))),
      ),
    );

    expect(failureOf(exit)).toBeInstanceOf(IssueOpenFailed);
    expect(failureOf(exit)).toMatchObject({ message: expect.stringMatching(/failed/) });
  });

  it('reports only where it failed and GitHub’s status', () => {
    const error = new IssueOpenFailed({ status: 422, message: 'Validation failed' });

    expect(error[ErrorReporter.attributes]).toEqual({ source: 'github-issues', status: 422 });
  });
});
