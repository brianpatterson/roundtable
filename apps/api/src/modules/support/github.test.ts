// The GitHub issues client against a scripted fetch: what it sends, and how it fails.
import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Cause, Effect, ErrorReporter, Exit, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { IssueOpenFailed, appJwt, makeGitHubIssues, type NewIssue } from './github.js';

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

const open = (fetch: typeof globalThis.fetch, key = pem) =>
  Effect.runPromiseExit(
    makeGitHubIssues({
      appId: '123',
      installationId: '42',
      privateKey: Redacted.make(key),
      repository: 'owner/repo',
    }).pipe(
      Effect.flatMap((issues) => issues.open(issue)),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ),
  );

const failureOf = <A>(exit: Exit.Exit<A, IssueOpenFailed>) =>
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
    expect(issueRequest?.body).toEqual(issue);
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

  it('fails without sending anything, or quoting the key, when the key is invalid', async () => {
    const { fetch, sent } = scriptedFetch({});
    const failure = failureOf(await open(fetch, 'not-a-key-secret-material'));

    expect(failure).toMatchObject({ message: 'The GitHub App private key is invalid' });
    expect(JSON.stringify(failure)).not.toContain('secret-material');
    expect(sent).toHaveLength(0);
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
    expect(garbledToken).toMatchObject({ message: 'Unexpected answer from GitHub' });
    expect(garbledIssue).toMatchObject({ message: 'Unexpected answer from GitHub' });
  });

  it('reports only where it failed and GitHub’s status', () => {
    const error = new IssueOpenFailed({ status: 422, message: 'Validation failed' });

    expect(error[ErrorReporter.attributes]).toEqual({ source: 'github-issues', status: 422 });
  });
});
