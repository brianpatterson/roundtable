// `run` and `why` against a stand-in GitHub that answers gather's reads from a small world and
// records every write, applying it to the world the way GitHub would, so a second run reads what
// the first wrote. The repository is o/r, the Owner o, and the time 12:00 on 2026-11-20.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type Json, type JsonObject, Read, parseJson } from './json.ts';
import { type Io, main } from './main.ts';
import { makeRunName, parseRunName } from './run-name.ts';

const AT = '2026-11-20T12:00:00.000Z';

const ago = (minutes: number): string => new Date(Date.parse(AT) - minutes * 60_000).toISOString();

/** When the stand-in GitHub says a write happened: a minute before the next run. */
const WRITTEN = ago(1);

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const MAIN = 'fedcba9876543210fedcba9876543210fedcba98';

interface Comment {
  readonly id: number;
  readonly user: { readonly login: string };
  readonly created_at: string;
  updated_at: string;
  body: string;
}

interface Issue {
  readonly number: number;
  readonly createdAt: string;
  readonly events: Json[];
  readonly comments: Comment[];
  readonly blockedBy: number[];
}

interface Pull {
  readonly number: number;
  readonly createdAt: string;
  readonly author: string;
  readonly head: string;
  readonly events: Json[];
  readonly comments: Comment[];
  readonly closes: number[];
}

interface World {
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, Pull>;
  readonly checks: Map<string, Json[]>;
  readonly statuses: Map<string, JsonObject[]>;
  readonly runs: JsonObject[];
  /** Every request, as `METHOD path`. */
  readonly requests: string[];
  /** Every write: a request that isn't a GET and isn't a GraphQL read. */
  readonly writes: { method: string; path: string; body: Json }[];
  /** Answers 500 to a write this says to fail. */
  fail: (method: string, path: string) => boolean;
  nextId: number;
}

const labeled = (minutes: number, name: string, login = 'o'): Json => ({
  __typename: 'LabeledEvent',
  createdAt: ago(minutes),
  label: { name },
  actor: { login },
});

function world(): World {
  return {
    issues: new Map(),
    pulls: new Map(),
    checks: new Map(),
    statuses: new Map(),
    runs: [],
    requests: [],
    writes: [],
    fail: () => false,
    nextId: 1000,
  };
}

function addIssue(w: World, number: number, events: Json[], blockedBy: number[] = []): void {
  w.issues.set(number, { number, createdAt: ago(600), events, comments: [], blockedBy });
}

function addPull(
  w: World,
  number: number,
  closes: number[],
  labels: string[],
  author = 'claude',
): void {
  w.pulls.set(number, {
    number,
    createdAt: ago(60),
    author,
    head: HEAD,
    events: labels.map((label) => labeled(60, label, 'github-actions')),
    comments: [],
    closes,
  });
}

/** The labels after a timeline's labeled and unlabeled events. */
function labelsOf(events: readonly Json[]): string[] {
  const labels = new Set<string>();

  for (const event of events) {
    const read = new Read(event, 'event');
    const name = read.field('label').field('name').optionalText();

    if (name === null) continue;

    if (read.field('__typename').text() === 'LabeledEvent') labels.add(name);
    else labels.delete(name);
  }

  return [...labels];
}

const page = (nodes: Json[]): Json => ({
  pageInfo: { hasNextPage: false, endCursor: null },
  nodes,
});

function answerGraphql(w: World, query: string, variables: Read): Json {
  const number = variables.field('number').absent() ? 0 : variables.field('number').number();
  const repository = (data: Json): Json => ({ data: { repository: data } });
  const issue = w.issues.get(number);
  const pull = w.pulls.get(number);

  if (query.includes('issues(states')) {
    const listed = [...w.issues.values()].filter((candidate) =>
      labelsOf(candidate.events).some((label) =>
        ['ready', 'building', 'needs-info', 'needs-human'].includes(label),
      ),
    );

    return repository({ issues: page(listed.map((candidate) => ({ number: candidate.number }))) });
  }

  if (query.includes('pullRequests(states')) {
    return repository({
      pullRequests: page(
        [...w.pulls.values()].map((candidate) => ({
          number: candidate.number,
          author: { login: candidate.author },
          labels: { nodes: labelsOf(candidate.events).map((name) => ({ name })) },
          closingIssuesReferences: { nodes: candidate.closes.map((n) => ({ number: n })) },
        })),
      ),
    });
  }

  if (query.includes('userContentEdits'))
    return repository({ issue: { userContentEdits: page([]) } });

  if (query.includes('blockedBy')) {
    return repository({
      issue: { blockedBy: page((issue?.blockedBy ?? []).map((n) => ({ number: n }))) },
    });
  }

  if (query.includes('issue(number') && query.includes('timelineItems'))
    return repository({ issue: { timelineItems: page(issue?.events ?? []) } });

  if (query.includes('issue(number')) {
    return repository({
      issue: { number, createdAt: issue?.createdAt ?? ago(600), author: { login: 'o' } },
    });
  }

  if (query.includes('commits(')) {
    return repository({
      pullRequest: {
        commits: page([
          {
            commit: {
              oid: pull?.head ?? '',
              committedDate: ago(30),
              authors: { nodes: [{ user: { login: 'claude' } }] },
            },
          },
        ]),
      },
    });
  }

  if (query.includes('pullRequest(number') && query.includes('timelineItems'))
    return repository({ pullRequest: { timelineItems: page(pull?.events ?? []) } });

  if (query.includes('pullRequest(number')) {
    return repository({
      pullRequest: {
        number,
        createdAt: pull?.createdAt ?? ago(60),
        author: { login: pull?.author ?? '' },
        headRefOid: pull?.head ?? '',
        mergeable: 'MERGEABLE',
        mergeCommit: null,
      },
    });
  }

  return { errors: [{ message: `the stand-in doesn't answer ${query}` }] };
}

function answerRead(w: World, path: string): Json | undefined {
  if (path === '/repos/o/r/actions/workflows/deploy.yml/runs') return { workflow_runs: [] };

  if (path === '/repos/o/r/actions/runs')
    return { total_count: w.runs.length, workflow_runs: w.runs };

  if (path === '/repos/o/r/commits')
    return [{ sha: MAIN, commit: { committer: { date: ago(300) } } }];

  const comments = /^\/repos\/o\/r\/issues\/(\d+)\/comments$/.exec(path)?.[1];

  if (comments !== undefined) {
    const number = Number(comments);

    return (w.issues.get(number)?.comments ?? w.pulls.get(number)?.comments ?? []).map(
      (comment) => ({
        id: comment.id,
        user: { login: comment.user.login },
        created_at: comment.created_at,
        updated_at: comment.updated_at,
        body: comment.body,
      }),
    );
  }

  const commit = /^\/repos\/o\/r\/commits\/([0-9a-f]+)\/(check-runs|statuses)$/.exec(path);

  if (commit !== null) {
    const [, sha = '', kind = ''] = commit;

    return kind === 'check-runs'
      ? { check_runs: w.checks.get(sha) ?? [] }
      : [...(w.statuses.get(sha) ?? [])];
  }

  return undefined;
}

/** Applies a write to the world the way GitHub would; `false` for one it doesn't know. */
function applyWrite(w: World, method: string, path: string, body: Read): boolean {
  const events = (number: number): Json[] | undefined =>
    w.issues.get(number)?.events ?? w.pulls.get(number)?.events;

  const addLabels = /^\/repos\/o\/r\/issues\/(\d+)\/labels$/.exec(path)?.[1];

  if (method === 'POST' && addLabels !== undefined) {
    for (const label of body.field('labels').items())
      events(Number(addLabels))?.push(labeled(1, label.text(), 'github-actions'));

    return true;
  }

  const removeLabel = /^\/repos\/o\/r\/issues\/(\d+)\/labels\/(.+)$/.exec(path);

  if (method === 'DELETE' && removeLabel !== null) {
    events(Number(removeLabel[1]))?.push({
      __typename: 'UnlabeledEvent',
      createdAt: WRITTEN,
      label: { name: decodeURIComponent(removeLabel[2] ?? '') },
      actor: { login: 'github-actions' },
    });

    return true;
  }

  const comment = /^\/repos\/o\/r\/issues\/(\d+)\/comments$/.exec(path)?.[1];

  if (method === 'POST' && comment !== undefined) {
    const number = Number(comment);
    const list = w.issues.get(number)?.comments ?? w.pulls.get(number)?.comments;

    w.nextId += 1;
    list?.push({
      id: w.nextId,
      user: { login: 'github-actions[bot]' },
      created_at: WRITTEN,
      updated_at: WRITTEN,
      body: body.field('body').text(),
    });

    return true;
  }

  const edit = /^\/repos\/o\/r\/issues\/comments\/(\d+)$/.exec(path)?.[1];

  if (method === 'PATCH' && edit !== undefined) {
    const all = [...w.issues.values(), ...w.pulls.values()].flatMap((item) => item.comments);
    const found = all.find((candidate) => candidate.id === Number(edit));

    if (found === undefined) return false;

    found.body = body.field('body').text();
    found.updated_at = WRITTEN;

    return true;
  }

  const status = /^\/repos\/o\/r\/statuses\/([0-9a-f]+)$/.exec(path)?.[1];

  if (method === 'POST' && status !== undefined) {
    w.statuses.set(status, [
      ...(w.statuses.get(status) ?? []),
      {
        context: body.field('context').text(),
        state: body.field('state').text(),
        description: body.field('description').text(),
        created_at: WRITTEN,
      },
    ]);

    return true;
  }

  if (
    method === 'POST' &&
    /^\/repos\/o\/r\/actions\/workflows\/[a-z-]+\.yml\/dispatches$/.test(path)
  ) {
    const inputs = body.field('inputs');
    const sha = inputs.field('sha').text();
    const kind = inputs.field('kind').text();
    const name = `${kind} #${inputs.field('item').text()} ${sha === '' ? '-' : sha.slice(0, 7)}`;
    const parsed = parseRunName(name);

    if (parsed === null) return false;

    w.nextId += 1;
    w.runs.push({
      display_title: makeRunName(parsed),
      id: w.nextId,
      event: 'workflow_dispatch',
      status: 'queued',
      conclusion: null,
      created_at: WRITTEN,
      run_started_at: null,
      updated_at: WRITTEN,
    });

    return true;
  }

  return method === 'POST' && /^\/repos\/o\/r\/actions\/runs\/\d+\/rerun-failed-jobs$/.test(path);
}

function fetchFor(w: World): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? 'GET';
    const path = url.pathname;

    w.requests.push(`${method} ${path}`);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token');

    const json = (body: Json, status = 200): Response =>
      new Response(JSON.stringify(body), { status });

    if (path === '/graphql') {
      const request = new Read(parseJson(String(init?.body), 'request'), 'request');

      return json(answerGraphql(w, request.field('query').text(), request.field('variables')));
    }

    if (method === 'GET') {
      const answer = answerRead(w, path);

      return answer === undefined ? json({ message: 'Not Found' }, 404) : json(answer);
    }

    const body = new Read(
      init?.body === undefined ? null : parseJson(String(init.body), 'body'),
      'body',
    );

    w.writes.push({ method, path, body: body.value ?? null });

    if (w.fail(method, path)) return json({ message: 'Server Error' }, 500);

    return applyWrite(w, method, path, body)
      ? new Response(null, { status: 204 })
      : json({ message: 'Not Found' }, 404);
  };
}

interface Ran {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}

async function conductor(
  w: World,
  args: string[],
  env: Io['env'] = { GH_TOKEN: 'token', GITHUB_REPOSITORY: 'o/r' },
  at = AT,
): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];

  const code = await main(args, {
    fetch: fetchFor(w),
    env,
    now: () => new Date(at),
    save: async () => {
      throw new Error('run and why save nothing');
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });

  return { code, out, err };
}

const writesOf = (w: World): string[] => w.writes.map((write) => `${write.method} ${write.path}`);

/** A Ticket the Owner approved an hour ago, with nothing blocking it. */
function approvedTicket(): World {
  const w = world();

  addIssue(w, 10, [labeled(60, 'ready')]);

  return w;
}

/**
 * Three Work items: #20 blocked by the open #21; #30's pull request #31 with CI running; #40
 * `building` for two hours with no build run and no pull request.
 */
function threeItems(): World {
  const w = world();

  addIssue(w, 20, [labeled(120, 'ready')], [21]);
  addIssue(w, 21, []);
  addIssue(w, 30, [labeled(300, 'ready')]);
  addPull(w, 31, [30], ['factory']);
  w.checks.set(HEAD, [
    {
      name: 'check',
      status: 'in_progress',
      conclusion: null,
      started_at: ago(10),
      completed_at: null,
    },
  ]);
  addIssue(w, 40, [labeled(180, 'ready'), labeled(120, 'building', 'github-actions')]);

  return w;
}

describe('run', () => {
  test('gathers every open Work item, decides with the time read once, and acts: a build is started, labeled, and its state comment posted', async () => {
    const w = approvedTicket();
    const { code, out } = await conductor(w, ['run']);

    assert.equal(code, 0);
    assert.deepEqual(writesOf(w), [
      'POST /repos/o/r/issues/10/labels',
      'POST /repos/o/r/actions/workflows/factory.yml/dispatches',
      'POST /repos/o/r/issues/10/comments',
    ]);
    assert.deepEqual(w.writes[0]?.body, { labels: ['building'] });
    assert.deepEqual(w.writes[1]?.body, {
      ref: 'main',
      inputs: { item: '10', kind: 'build', sha: '', attempt: '1' },
    });

    const comment = new Read(w.writes[2]?.body, 'comment').field('body').text();

    assert.equal(
      comment,
      `<!-- factory-state -->\n**State:** \`building\`\nNothing blocks it, so the factory starts building it.\n\n<sub>Since ${AT}: the factory's Conductor, ADR-0075.</sub>`,
    );
    assert.ok(out.includes('#10: building: Nothing blocks it, so the factory starts building it.'));
    assert.ok(out.includes('Write #10: label #10 building'));
  });

  test('--dry-run prints each write it would make, one per line, and makes none', async () => {
    const w = approvedTicket();
    const { code, out } = await conductor(w, ['run', '--dry-run']);

    assert.equal(code, 0);
    assert.deepEqual(w.writes, []);
    assert.ok(
      w.requests.every((request) => request.startsWith('GET ') || request === 'POST /graphql'),
    );
    assert.deepEqual(
      out.filter((line) => line.startsWith('Would write ')),
      [
        'Would write #10: label #10 building',
        'Would write #10: start the build Executor for #10 through factory.yml (sha -, attempt 1)',
        'Would write #10: post the state comment on #10: building',
      ],
    );
  });

  test('a second run with nothing changed on GitHub makes no writes at all', async () => {
    const w = threeItems();

    assert.equal((await conductor(w, ['run'])).code, 0);
    assert.deepEqual(writesOf(w), [
      'POST /repos/o/r/issues/20/comments',
      'POST /repos/o/r/issues/30/labels',
      `POST /repos/o/r/statuses/${HEAD}`,
      'POST /repos/o/r/issues/30/comments',
      'POST /repos/o/r/issues/40/labels',
      'DELETE /repos/o/r/issues/40/labels/building',
      'POST /repos/o/r/issues/40/comments',
      'POST /repos/o/r/issues/40/comments',
    ]);

    w.writes.length = 0;

    assert.equal((await conductor(w, ['run'])).code, 0);
    assert.deepEqual(w.writes, []);
  });

  test("a run minutes later writes nothing while only a wait's minute count has moved on, and a pull request the factory doesn't look after shows the Owner's turn", async () => {
    const w = world();

    // Dependabot's, labeled neither `factory` nor `autofix`, with CI stuck for two hours.
    addPull(w, 60, [], [], 'dependabot[bot]');
    w.checks.set(HEAD, [
      {
        name: 'check',
        status: 'in_progress',
        conclusion: null,
        started_at: ago(120),
        completed_at: null,
      },
    ]);

    assert.equal((await conductor(w, ['run'])).code, 0);
    assert.deepEqual(writesOf(w), [
      `POST /repos/o/r/statuses/${HEAD}`,
      'POST /repos/o/r/issues/60/comments',
    ]);
    assert.deepEqual(w.writes[0]?.body, {
      context: 'factory',
      state: 'success',
      description: 'Done: checking, your turn',
      target_url: null,
    });

    w.writes.length = 0;

    const later = new Date(Date.parse(AT) + 5 * 60_000).toISOString();

    assert.equal(
      (await conductor(w, ['run'], { GH_TOKEN: 'token', GITHUB_REPOSITORY: 'o/r' }, later)).code,
      0,
    );
    assert.deepEqual(w.writes, []);
  });

  test('a Ticket building is labeled `building`, and a hand-over swaps it for `needs-human` with the reason, posted once', async () => {
    const w = threeItems();

    await conductor(w, ['run']);

    assert.deepEqual(labelsOf(w.issues.get(30)?.events ?? []), ['ready', 'building']);
    assert.deepEqual(labelsOf(w.issues.get(40)?.events ?? []), ['ready', 'needs-human']);

    const comments = w.issues.get(40)?.comments.map((comment) => comment.body) ?? [];

    assert.equal(comments.length, 2);
    assert.match(
      comments[0] ?? '',
      /^<!-- factory-conductor -->\nThe factory started building it 120 minutes ago/,
    );
    // The state comment keeps the reason it was handed over for.
    assert.match(
      comments[1] ?? '',
      /^<!-- factory-state -->\n\*\*State:\*\* `needs-human`\nThe factory started building it/,
    );
  });

  test('the factory status on the head: pending while CI runs, set once', async () => {
    const w = threeItems();

    await conductor(w, ['run']);
    await conductor(w, ['run']);

    assert.deepEqual(w.statuses.get(HEAD), [
      {
        context: 'factory',
        state: 'pending',
        description: 'Working: checking',
        created_at: WRITTEN,
      },
    ]);
  });

  test('a cancelled check reruns its Actions run once', async () => {
    const w = world();

    addPull(w, 50, [], ['factory']);
    w.checks.set(HEAD, [
      {
        name: 'check',
        status: 'completed',
        conclusion: 'cancelled',
        started_at: ago(20),
        completed_at: ago(15),
        details_url: 'https://github.com/o/r/actions/runs/800/job/8001',
      },
      {
        name: 'lint',
        status: 'completed',
        conclusion: 'cancelled',
        started_at: ago(20),
        completed_at: ago(15),
        details_url: 'https://github.com/o/r/actions/runs/800/job/8002',
      },
    ]);

    const { code } = await conductor(w, ['run']);

    assert.equal(code, 0);
    assert.deepEqual(writesOf(w), [
      'POST /repos/o/r/actions/runs/800/rerun-failed-jobs',
      `POST /repos/o/r/statuses/${HEAD}`,
      'POST /repos/o/r/issues/50/comments',
    ]);
  });

  test('a write that fails: the others are still made, and run exits 1 naming it', async () => {
    const w = threeItems();

    w.fail = (method, path) => method === 'POST' && path === '/repos/o/r/issues/40/labels';

    const { code, err } = await conductor(w, ['run']);

    assert.equal(code, 1);
    assert.equal(w.writes.length, 8);
    assert.deepEqual(err, ['Failed: #40: label #40 needs-human: GitHub answered 500']);
  });

  test('a build that fails to start takes back its `building` label', async () => {
    const w = approvedTicket();

    w.fail = (_method, path) => path.endsWith('/dispatches');

    const { code, err } = await conductor(w, ['run']);

    assert.equal(code, 1);
    assert.deepEqual(writesOf(w), [
      'POST /repos/o/r/issues/10/labels',
      'POST /repos/o/r/actions/workflows/factory.yml/dispatches',
      'DELETE /repos/o/r/issues/10/labels/building',
      'POST /repos/o/r/issues/10/comments',
    ]);
    assert.deepEqual(labelsOf(w.issues.get(10)?.events ?? []), ['ready']);
    assert.deepEqual(err, [
      'Failed: #10: start the build Executor for #10 through factory.yml (sha -, attempt 1): GitHub answered 500',
    ]);
  });

  test('no GH_TOKEN: exits 1 before reading anything', async () => {
    const w = approvedTicket();
    const { code, err } = await conductor(w, ['run'], { GITHUB_REPOSITORY: 'o/r' });

    assert.equal(code, 1);
    assert.deepEqual(w.requests, []);
    assert.deepEqual(err, [
      'Set GH_TOKEN to a GitHub token and GITHUB_REPOSITORY to <owner>/<name>.',
    ]);
  });

  test('an unknown argument is a usage error', async () => {
    const { code } = await conductor(world(), ['run', '--force']);

    assert.equal(code, 2);
  });
});

describe('why', () => {
  test("prints the Work item's state, action, reason, the facts and its budget count, and writes nothing", async () => {
    const w = threeItems();
    const { code, out } = await conductor(w, ['why', '40']);

    assert.equal(code, 0);
    assert.deepEqual(w.writes, []);
    assert.ok(
      w.requests.every((request) => request.startsWith('GET ') || request === 'POST /graphql'),
    );
    assert.equal(out[0], '#40: needs-human');
    assert.equal(out[1], 'Action: hand over: label it `needs-human`');
    assert.match(out[2] ?? '', /^Reason: The factory started building it 120 minutes ago/);
    assert.ok(
      out.includes(`Approval: \`ready\` by o at ${ago(180)}, an Approval since ${ago(180)}`),
    );
    assert.ok(out.includes('Blockers: none'));
    assert.ok(out.includes('Pull request: none'));
    assert.ok(out.includes('Executor runs: running none; finished in 24 hours none'));
    assert.ok(
      out.includes(
        'Dispatch budget: 0 of 20 Executor starts for this Work item, and 0 of 60 in all, in 24 hours',
      ),
    );
    assert.ok(out.includes('Writes `run` would make:'));
    assert.ok(out.includes('  label #40 needs-human'));
  });

  test("a pull request's number finds its Ticket's Work item, with the head, checks, Review and Attempts", async () => {
    const { code, out } = await conductor(threeItems(), ['why', '31']);

    assert.equal(code, 0);
    assert.equal(out[0], '#30: checking');
    assert.ok(out.includes(`Head: ${HEAD.slice(0, 7)}, committed ${ago(30)}`));
    assert.ok(out.includes('Checks: check in_progress'));
    assert.ok(out.includes('Review: none'));
    assert.ok(
      out.includes(
        'Attempts: CI fix 0, Rework 0, Minor passes 0 since the pull request opened; conflict 0',
      ),
    );
    assert.ok(out.includes('Blockers: none'));
  });

  test("a number that isn't an open Work item: exits 1", async () => {
    const { code, err } = await conductor(threeItems(), ['why', '99']);

    assert.equal(code, 1);
    assert.match(err[0] ?? '', /^#99 isn't an open Work item/);
  });

  test('no GH_TOKEN: exits 1 before reading anything', async () => {
    const w = threeItems();
    const { code } = await conductor(w, ['why', '40'], {});

    assert.equal(code, 1);
    assert.deepEqual(w.requests, []);
  });
});
