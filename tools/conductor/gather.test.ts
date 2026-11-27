// gather against a stand-in fetch that answers like GitHub. The repository is o/r.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type GitHub, gather, listWorkItems } from './gather.ts';
import { type Json, Read, parseJson } from './json.ts';
import { observe } from './observe.ts';
import type { GatheredWorkItem, RawWorkItem } from './raw.ts';

const time = (minutes: number): string =>
  new Date(Date.UTC(2026, 10, 20, 10, minutes)).toISOString();

const page = (nodes: Json[], next: string | null = null): Json => ({
  pageInfo: { hasNextPage: next !== null, endCursor: next },
  nodes,
});

const labeled = (minutes: number, name: string): Json => ({
  __typename: 'LabeledEvent',
  createdAt: time(minutes),
  label: { name },
  actor: { login: 'o' },
});

// #10's timeline is 150 events long, over two pages: the label added last is the one that counts.
const timeline10 = [
  ...Array.from({ length: 149 }, (_, i) => labeled(i - 200, i % 2 === 0 ? 'enhancement' : 'bug')),
  labeled(0, 'ready'),
];

const pullRequestOpen = (
  number: number,
  labels: string[],
  author: string,
  closes: number[] = [],
): Json => ({
  number,
  author: { login: author },
  labels: { nodes: labels.map((name) => ({ name })) },
  closingIssuesReferences: { nodes: closes.map((n) => ({ number: n })) },
});

interface Answer {
  readonly status?: number;
  readonly body: Json;
  readonly link?: string;
}

/** What the stand-in GitHub answers to each GraphQL query, by what it asks for and the variables. */
function answerGraphql(query: string, variables: Read, refuse: ReadonlySet<number>): Answer {
  const number = variables.field('number').absent() ? 0 : variables.field('number').number();
  const cursor = variables.field('cursor').optionalText();
  const repository = (data: Json): Answer => ({ body: { data: { repository: data } } });

  if (refuse.has(number))
    return { body: { errors: [{ message: `Could not resolve to an issue #${number}` }] } };

  if (query.includes('issues(states'))
    return repository({ issues: page([{ number: 10 }, { number: 20 }]) });

  if (query.includes('pullRequests(states')) {
    return repository({
      pullRequests:
        cursor === null
          ? page(
              [
                pullRequestOpen(11, ['factory'], 'claude', [10]),
                pullRequestOpen(12, [], 'dependabot'),
              ],
              'p2',
            )
          : page([
              pullRequestOpen(13, ['autofix'], 'o'),
              pullRequestOpen(14, ['enhancement'], 'someone'),
              pullRequestOpen(15, ['factory'], 'claude', [99]),
            ]),
    });
  }

  if (query.includes('userContentEdits')) {
    return repository({
      issue: { userContentEdits: page([{ editedAt: time(-300), editor: { login: 'o' } }]) },
    });
  }

  if (query.includes('blockedBy'))
    return repository({ issue: { blockedBy: page(number === 10 ? [{ number: 3 }] : []) } });

  if (query.includes('issue(number') && query.includes('timelineItems')) {
    if (number === 3) {
      return repository({
        issue: {
          timelineItems: page([
            {
              __typename: 'ClosedEvent',
              createdAt: time(-30),
              closer: { __typename: 'PullRequest', merged: true, mergeCommit: { oid: 'm3' } },
            },
          ]),
        },
      });
    }

    const nodes = cursor === null ? timeline10.slice(0, 100) : timeline10.slice(100);

    return repository({ issue: { timelineItems: page(nodes, cursor === null ? 't2' : null) } });
  }

  if (query.includes('issue(number')) {
    return repository({ issue: { number, createdAt: time(-400), author: { login: 'o' } } });
  }

  if (query.includes('commits(')) {
    return repository({
      pullRequest: {
        commits: page([
          {
            commit: {
              oid: `g${number}`,
              committedDate: time(4),
              authors: { nodes: [{ user: { login: 'claude' } }] },
            },
          },
          {
            commit: {
              oid: `h${number}`,
              committedDate: time(5),
              authors: { nodes: [{ user: { login: 'claude' } }] },
            },
          },
        ]),
      },
    });
  }

  if (query.includes('pullRequest(number') && query.includes('timelineItems')) {
    return repository({ pullRequest: { timelineItems: page([labeled(4, 'factory')]) } });
  }

  if (query.includes('pullRequest(number')) {
    return repository({
      pullRequest: {
        number,
        createdAt: time(4),
        author: { login: 'claude' },
        headRefOid: `h${number}`,
        mergeable: 'MERGEABLE',
        mergeCommit: null,
      },
    });
  }

  return { status: 404, body: { message: 'Not Found' } };
}

function answerRest(path: string, search: URLSearchParams): Answer {
  if (path === '/repos/o/r/actions/workflows/deploy.yml/runs') {
    return {
      body: { workflow_runs: [{ head_sha: 'd1', updated_at: time(-10), name: 'Deploy', id: 1 }] },
    };
  }

  if (path === '/repos/o/r/actions/runs') {
    return {
      body: {
        workflow_runs: [
          {
            display_title: 'build #10 -',
            status: 'completed',
            created_at: time(-60),
            run_started_at: time(-60),
            updated_at: time(-50),
          },
          {
            display_title: 'CI',
            status: 'completed',
            created_at: time(-60),
            run_started_at: time(-60),
            updated_at: time(-50),
          },
        ],
      },
    };
  }

  if (path === '/repos/o/r/compare/m3...d1') return { body: { status: 'ahead', files: [] } };

  if (/^\/repos\/o\/r\/commits\/[gh]\d+\/check-runs$/.test(path)) {
    // Two pages, linked the way GitHub links them.
    return search.get('page') === '2'
      ? {
          body: {
            check_runs: [
              {
                name: 'CodeQL',
                status: 'queued',
                conclusion: null,
                started_at: time(6),
                completed_at: null,
                output: {},
              },
            ],
          },
        }
      : {
          body: {
            check_runs: [
              {
                name: 'check',
                status: 'completed',
                conclusion: 'success',
                started_at: time(5),
                completed_at: time(6),
                app: {},
              },
            ],
          },
          link: `<https://api.github.com${path}?per_page=100&page=2>; rel="next", <https://api.github.com${path}?per_page=100&page=2>; rel="last"`,
        };
  }

  if (/^\/repos\/o\/r\/commits\/[gh]\d+\/statuses$/.test(path)) {
    return {
      body: [
        {
          context: 'factory',
          state: 'pending',
          description: 'Working: reviewing',
          created_at: time(6),
          url: 'x',
        },
      ],
    };
  }

  if (/^\/repos\/o\/r\/issues\/\d+\/comments$/.test(path)) {
    return {
      body: [
        {
          user: { login: 'github-actions[bot]' },
          created_at: time(7),
          updated_at: time(8),
          body: '<!-- factory-ci-fix -->\n### CI fix, attempt 1 of 2: pushed a fix\n\nThe secret plan.\n\n<sub>[Run](x), for commit h11. ADR-0028.</sub>',
        },
        {
          user: { login: 'stranger' },
          created_at: time(7),
          updated_at: time(7),
          body: '<!-- factory-ci-fix -->',
        },
        {
          user: { login: 'github-actions[bot]' },
          created_at: time(7),
          updated_at: time(7),
          body: 'The sweeper reran CI once.',
        },
      ],
    };
  }

  return { status: 404, body: { message: 'Not Found' } };
}

/** A stand-in GitHub, and every request it was sent. */
interface FakeGitHub {
  readonly github: GitHub;
  readonly requests: string[];
}

/** A stand-in fetch for GitHub, refusing every read about the numbers in `refuse`. */
function fakeGitHub(refuse: ReadonlySet<number> = new Set()): FakeGitHub {
  const requests: string[] = [];

  const fakeFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);

    requests.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);

    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token');

    let answer: Answer;

    if (url.pathname === '/graphql') {
      const request = new Read(parseJson(String(init?.body), 'request'), 'request');

      answer = answerGraphql(request.field('query').text(), request.field('variables'), refuse);
    } else {
      const number = /\/issues\/(\d+)\//.exec(url.pathname)?.[1];

      answer =
        number !== undefined && refuse.has(Number(number))
          ? { status: 403, body: { message: 'Forbidden' } }
          : answerRest(url.pathname, url.searchParams);
    }

    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: answer.link === undefined ? {} : { link: answer.link },
    });
  };

  return { github: { fetch: fakeFetch, token: 'token', repository: 'o/r' }, requests };
}

const options = { since: new Date(time(-24 * 60)), commits: 'head' } as const;

function readable(items: readonly GatheredWorkItem[], number: number): RawWorkItem {
  const item = items.find((candidate) => candidate.number === number);

  assert.ok(item !== undefined && !('unreadable' in item), `#${number} should be readable`);

  return item;
}

test("the Work items: tickets by label, and factory, autofix and Dependabot's pull requests, each with the Ticket it closes", async () => {
  assert.deepEqual(await listWorkItems(fakeGitHub().github), [
    { number: 10, ticket: 10, pullRequest: 11 },
    { number: 12, ticket: null, pullRequest: 12 },
    { number: 13, ticket: null, pullRequest: 13 },
    { number: 15, ticket: null, pullRequest: 15 },
    { number: 20, ticket: 20, pullRequest: null },
  ]);
});

test("the listing follows the pull requests' pages", async () => {
  const { github, requests } = fakeGitHub();

  await listWorkItems(github);

  assert.equal(
    requests.filter((request) => request.startsWith('POST /graphql')).length,
    3,
    'one issue page, two pull request pages',
  );
});

test('one Work item is read whole, following every page, and trimmed to what observe reads', async () => {
  const items = await gather(fakeGitHub().github, options);
  const item = readable(items, 10);

  const raw = new Read(JSON.parse(JSON.stringify(item)), 'raw');

  assert.equal(raw.field('ticket').field('timeline').items().length, 150);
  assert.equal(raw.field('blockers').items()[0]?.field('number').number(), 3);
  assert.equal(raw.field('pullRequest').field('number').number(), 11);
  assert.deepEqual(
    raw
      .field('checks')
      .items()[0]
      ?.field('checkRuns')
      .items()
      .map((run) => run.field('name').text()),
    ['check', 'CodeQL'],
  );
  assert.deepEqual(raw.field('comments').json(), [
    {
      user: { login: 'github-actions[bot]' },
      created_at: time(7),
      updated_at: time(8),
      body: '<!-- factory-ci-fix -->\n### CI fix, attempt 1 of 2: pushed a fix\n<sub>[Run](x), for commit h11. ADR-0028.</sub>',
    },
  ]);
  assert.deepEqual(raw.field('inclusions').json(), [
    { commit: 'm3', deploy: 'd1', status: 'ahead' },
  ]);
  assert.deepEqual(
    raw
      .field('runs')
      .items()
      .map((run) => run.field('display_title').text()),
    ['build #10 -'],
  );

  // Fields observe doesn't read are left out.
  assert.equal(JSON.stringify(item).includes('"app"'), false);
  assert.equal(JSON.stringify(item).includes('"url"'), false);
  assert.equal(JSON.stringify(item).includes('secret plan'), false);
});

test('what gather reads, observe reads', async () => {
  const state = observe(
    readable(await gather(fakeGitHub().github, options), 10),
    new Date(time(10)),
  );

  assert.ok(state.ticket.known && state.ticket.value?.ready?.approved === true);
  assert.ok(state.ticket.known && state.ticket.value?.blockers.known);
  assert.deepEqual(state.ticket.known && state.ticket.value?.blockers, {
    known: true,
    value: [
      {
        number: 3,
        status: 'merged',
        deployed: { known: true, value: true },
        held: null,
        labels: [],
      },
    ],
  });
  assert.ok(state.pullRequest.known && state.pullRequest.value?.checks.known);
  assert.deepEqual(state.pullRequest.known && state.pullRequest.value?.attempts, {
    known: true,
    value: { since: null, ciFix: 1, rework: 0, minorPasses: 0, conflict: [] },
  });
  assert.deepEqual(state.runs, {
    known: true,
    value: { active: [], startedLastDay: { item: 1, all: 1 } },
  });
});

test('a Work item GitHub refuses is unreadable, with the reason, and the rest are still gathered', async () => {
  const items = await gather(fakeGitHub(new Set([20, 13])).github, options);

  assert.deepEqual(
    items.map((item) => item.number),
    [10, 12, 13, 15, 20],
  );
  assert.deepEqual(
    items.find((item) => item.number === 20),
    {
      number: 20,
      unreadable: 'GitHub refused issue #20: Could not resolve to an issue #20',
    },
  );
  assert.deepEqual(
    items.find((item) => item.number === 13),
    {
      number: 13,
      unreadable: 'GitHub refused pull request #13: Could not resolve to an issue #13',
    },
  );
  readable(items, 10);
  readable(items, 12);
});

test('a REST refusal and a failed connection are unreadable too', async () => {
  const { github } = fakeGitHub();

  const failing: GitHub = {
    ...github,
    fetch: async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);

      if (url.includes('/issues/15/comments')) return new Response('{}', { status: 502 });

      if (url.includes('/issues/12/comments')) throw new TypeError('fetch failed');

      return github.fetch(input, init);
    },
  };

  const items = await gather(failing, options);

  assert.deepEqual(
    items.find((item) => item.number === 15),
    {
      number: 15,
      unreadable: 'GitHub answered 502 to GET /repos/o/r/issues/15/comments?per_page=100',
    },
  );
  assert.deepEqual(
    items.find((item) => item.number === 12),
    {
      number: 12,
      unreadable:
        "GitHub couldn't be reached for GET /repos/o/r/issues/12/comments?per_page=100: fetch failed",
    },
  );
  readable(items, 10);
});

test('every commit is read for a history fixture, only the head otherwise', async () => {
  const head = fakeGitHub();
  const all = fakeGitHub();

  await gather(head.github, options);
  await gather(all.github, { ...options, commits: 'all' });

  const commitsRead = (requests: string[]) =>
    [
      ...new Set(
        requests.flatMap((request) =>
          request.includes('/check-runs') ? [request.split('/')[5]] : [],
        ),
      ),
    ].sort();

  // Four pull requests of two commits each.
  assert.deepEqual(commitsRead(head.requests), ['h11', 'h12', 'h13', 'h15']);
  assert.deepEqual(commitsRead(all.requests), [
    'g11',
    'g12',
    'g13',
    'g15',
    'h11',
    'h12',
    'h13',
    'h15',
  ]);
});
