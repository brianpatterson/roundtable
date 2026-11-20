// The GitHub issues client against a scripted fetch: what it sends, and how it fails.
import { describe, expect, it } from 'vitest';
import { Cause, Effect, ErrorReporter, Exit, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { IssueOpenFailed, makeGitHubIssues, type NewIssue } from './github.js';

const issue: NewIssue = {
  title: 'User report 1: /',
  body: 'Safe context',
  labels: ['bug', 'user-report'],
};

interface Sent {
  readonly url: string;
  readonly headers: Headers;
  readonly body: unknown;
}

function scriptedFetch(answer: () => Response | Promise<Response>) {
  const sent: Sent[] = [];

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);

    sent.push({
      url: request.url,
      headers: request.headers,
      body: Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(await request.text()),
    });

    return answer();
  };

  return { fetch, sent };
}

const open = (fetch: typeof globalThis.fetch) =>
  Effect.runPromiseExit(
    makeGitHubIssues({ token: Redacted.make('github_pat_x'), repository: 'owner/repo' }).pipe(
      Effect.flatMap((issues) => issues.open(issue)),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ),
  );

const failureOf = <A>(exit: Exit.Exit<A, IssueOpenFailed>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

describe('GitHub issues client', () => {
  it('posts the issue to the repository with the token, and returns its link', async () => {
    const { fetch, sent } = scriptedFetch(() =>
      Response.json(
        { number: 7, html_url: 'https://github.com/owner/repo/issues/7' },
        { status: 201 },
      ),
    );

    expect(await open(fetch)).toEqual(
      Exit.succeed({ url: 'https://github.com/owner/repo/issues/7' }),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('https://api.github.com/repos/owner/repo/issues');
    expect(sent[0]?.headers.get('authorization')).toBe('Bearer github_pat_x');
    expect(sent[0]?.headers.get('accept')).toBe('application/vnd.github+json');
    expect(sent[0]?.headers.get('user-agent')).toBe('roundtable-api');
    expect(sent[0]?.body).toEqual(issue);
  });

  it('fails with GitHub’s status when it refuses, without retrying', async () => {
    const { fetch, sent } = scriptedFetch(() =>
      Response.json({ message: 'Bad credentials' }, { status: 401 }),
    );

    const failure = failureOf(await open(fetch));

    expect(failure).toBeInstanceOf(IssueOpenFailed);
    expect(failure).toMatchObject({
      status: 401,
      message: expect.stringContaining('Bad credentials'),
    });
    expect(sent).toHaveLength(1);
  });

  it('fails when GitHub cannot be reached or answers something unexpected', async () => {
    const unreachable = failureOf(
      await open(scriptedFetch(() => Promise.reject(new TypeError('fetch failed'))).fetch),
    );

    const garbled = failureOf(await open(scriptedFetch(() => new Response('<html>')).fetch));

    expect(unreachable).toBeInstanceOf(IssueOpenFailed);
    expect(garbled).toMatchObject({ message: 'Unexpected answer from GitHub' });
  });

  it('reports only where it failed and GitHub’s status', () => {
    const error = new IssueOpenFailed({ status: 422, message: 'Validation failed' });

    expect(error[ErrorReporter.attributes]).toEqual({ source: 'github-issues', status: 422 });
  });
});
