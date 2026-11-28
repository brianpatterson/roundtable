// The recorder against a stand-in fetch that answers like GitHub, never GitHub itself. The
// repository is o/r, and three invented Work items live in it:
//   #40, a Ticket built into pull request #41: queued, built, CI fixed, reviewed, merged, deployed;
//   #50, a pull request whose CI was cancelled twice, then handed over and handed back;
//   #60, a User report whose Approval was withdrawn after someone else edited it.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import type { Action } from './decide.ts';
import {
  CREDENTIAL_PATTERNS,
  type Fixture,
  credentialIn,
  fixtureOf,
  parseFixture,
  serialize,
} from './fixture.ts';
import { GATHER_VERSION, type GitHub, gatherWorkItem } from './gather.ts';
import { type Json, Read, parseJson } from './json.ts';
import { type Io, main } from './main.ts';
import type { RawWorkItem } from './raw.ts';
import { type Checkpoint, checkpoints as checkpointsOf } from './record.ts';

const time = (minutes: number): string =>
  new Date(Date.UTC(2026, 10, 20, 10, 0) + minutes * 60_000).toISOString();

const sha = (letter: string): string => letter.repeat(40);

const C1 = sha('a');
const C2 = sha('b');
const MERGE = sha('c');
const MAIN = sha('d');
const DEPLOY = sha('e');
const F1 = sha('f');

const page = (nodes: Json[]): Json => ({
  pageInfo: { hasNextPage: false, endCursor: null },
  nodes,
});

const labelEvent = (added: boolean, minutes: number, name: string, actor: string): Json => ({
  __typename: added ? 'LabeledEvent' : 'UnlabeledEvent',
  createdAt: time(minutes),
  label: { name },
  actor: { login: actor },
});

const commitNode = (oid: string, minutes: number, login: string): Json => ({
  commit: { oid, committedDate: time(minutes), authors: { nodes: [{ user: { login } }] } },
});

const checkRun = (name: string, started: number, completed: number, conclusion: string): Json => ({
  name,
  status: 'completed',
  conclusion,
  started_at: time(started),
  completed_at: time(completed),
  html_url: 'x',
});

const comment = (login: string, minutes: number, body: string, updated = minutes): Json => ({
  user: { login },
  created_at: time(minutes),
  updated_at: time(updated),
  body,
});

interface Issue {
  readonly createdAt: number;
  readonly closedAt: number | null;
  readonly author: string;
  readonly timeline: Json[];
  readonly edits: Json[];
  readonly comments: Json[];
  readonly closedBy: number[];
}

interface PullRequest {
  readonly createdAt: number;
  readonly closedAt: number | null;
  readonly author: string;
  readonly head: string;
  readonly mergeCommit: string | null;
  readonly closes: number[];
  readonly commits: Json[];
  readonly timeline: Json[];
  readonly comments: Json[];
  readonly checks: Readonly<Record<string, Json[]>>;
  readonly statuses: Readonly<Record<string, Json[]>>;
}

const ISSUES = new Map<number, Issue>([
  [
    40,
    {
      createdAt: -600,
      closedAt: 200,
      author: 'o',
      timeline: [
        labelEvent(true, 0, 'ready', 'o'),
        labelEvent(true, 30, 'building', 'github-actions'),
        {
          __typename: 'ClosedEvent',
          createdAt: time(200),
          closer: { __typename: 'PullRequest', merged: true, mergeCommit: { oid: MERGE } },
        },
      ],
      edits: [{ editedAt: time(-500), editor: { login: 'o' } }],
      comments: [
        comment(
          'github-actions[bot]',
          1,
          '<!-- factory-dispatch -->\nThe factory will build this later: the factory builds one ticket at a time, and #30, #40 is in flight until it is deployed. It says here when it starts. ADR-0047.',
        ),
        comment(
          'github-actions[bot]',
          30,
          '<!-- factory-dispatch -->\nThe factory started building this: nothing blocks it any more. ADR-0047.',
        ),
        comment('stranger', 31, '<!-- factory-dispatch -->\n#99 is in flight'),
      ],
      closedBy: [41],
    },
  ],
  [
    60,
    {
      createdAt: -100,
      closedAt: null,
      author: 'github-actions',
      timeline: [
        labelEvent(true, -100, 'user-report', 'github-actions'),
        labelEvent(true, 0, 'ready', 'o'),
        labelEvent(false, 20, 'ready', 'github-actions'),
      ],
      edits: [{ editedAt: time(10), editor: { login: 'someone' } }],
      comments: [
        comment('o', 5, 'The private words of the report.'),
        comment('github-actions[bot]', 6, 'Quoting the private words of the report.'),
      ],
      closedBy: [],
    },
  ],
]);

const PULL_REQUESTS = new Map<number, PullRequest>([
  [
    41,
    {
      createdAt: 55,
      closedAt: 200,
      author: 'claude',
      head: C2,
      mergeCommit: MERGE,
      closes: [40],
      commits: [commitNode(C1, 50, 'claude'), commitNode(C2, 70, 'claude')],
      timeline: [
        labelEvent(true, 55, 'factory', 'github-actions'),
        { __typename: 'MergedEvent', createdAt: time(200), commit: { oid: MERGE } },
      ],
      comments: [
        comment(
          'github-actions[bot]',
          71,
          '<!-- factory-ci-fix -->\n### CI fix, attempt 1 of 2: pushed a fix\n\nWhat the fixer did.\n\n<sub>[Run](x), for commit aaaaaaa. ADR-0028.</sub>',
        ),
        comment(
          'github-actions[bot]',
          90,
          '<!-- factory-review -->\n### Factory review: ✅ Ready for you\n\nThe review.\n\n<sub>Commit bbbbbbb, reviewed by the factory.</sub>',
        ),
        comment('stranger', 91, '<!-- factory-ci-fix -->\nfor commit bbbbbbb'),
        comment('o', 120, '@claude what the Owner asked'),
      ],
      checks: {
        [C1]: [checkRun('check', 56, 60, 'failure')],
        [C2]: [checkRun('check', 72, 80, 'success'), checkRun('CodeQL', 72, 79, 'success')],
      },
      statuses: {
        [C1]: [],
        [C2]: [
          {
            context: 'factory',
            state: 'pending',
            description: 'Working: reviewing',
            created_at: time(81),
          },
          {
            context: 'factory',
            state: 'success',
            description: 'Done: ready for you',
            created_at: time(95),
          },
        ],
      },
    },
  ],
  [
    50,
    {
      createdAt: 0,
      closedAt: null,
      author: 'claude',
      head: F1,
      mergeCommit: null,
      closes: [],
      commits: [commitNode(F1, -5, 'o')],
      timeline: [
        labelEvent(true, 0, 'factory', 'github-actions'),
        labelEvent(true, 60, 'needs-human', 'github-actions'),
        labelEvent(false, 100, 'needs-human', 'o'),
      ],
      comments: [],
      checks: {
        [F1]: [
          checkRun('check', 1, 10, 'cancelled'),
          checkRun('check', 30, 40, 'cancelled'),
          // Label events start a workflow whose job is skipped, again and again: not a rerun.
          checkRun('review', 2, 2, 'skipped'),
          checkRun('review', 3, 3, 'skipped'),
        ],
      },
      statuses: { [F1]: [] },
    },
  ],
]);

interface Answer {
  readonly status?: number;
  readonly body: Json;
}

const repository = (data: Json): Answer => ({ body: { data: { repository: data } } });

const NOT_FOUND: Answer = { status: 404, body: { message: 'Not Found' } };

function answerGraphql(query: string, number: number): Answer {
  const issue = ISSUES.get(number);
  const pr = PULL_REQUESTS.get(number);

  if (query.includes('issueOrPullRequest')) {
    if (issue !== undefined) {
      return repository({
        issueOrPullRequest: {
          __typename: 'Issue',
          number,
          createdAt: time(issue.createdAt),
          closedAt: issue.closedAt === null ? null : time(issue.closedAt),
          closedByPullRequestsReferences: page(issue.closedBy.map((n) => ({ number: n }))),
        },
      });
    }

    if (pr !== undefined) {
      return repository({
        issueOrPullRequest: {
          __typename: 'PullRequest',
          number,
          createdAt: time(pr.createdAt),
          closedAt: pr.closedAt === null ? null : time(pr.closedAt),
          closingIssuesReferences: page(pr.closes.map((n) => ({ number: n }))),
        },
      });
    }

    return {
      body: { errors: [{ message: `Could not resolve to an issue or pull request #${number}` }] },
    };
  }

  if (issue !== undefined) {
    if (query.includes('userContentEdits'))
      return repository({ issue: { userContentEdits: page(issue.edits) } });

    if (query.includes('blockedBy')) return repository({ issue: { blockedBy: page([]) } });

    if (query.includes('timelineItems'))
      return repository({ issue: { timelineItems: page(issue.timeline) } });

    // GitHub answers only what's asked: the title and body here stand for what a careless query would read.
    return repository({
      issue: {
        number,
        createdAt: time(issue.createdAt),
        author: { login: issue.author },
        title: 'User report: the private title',
        body: 'The private words of the report.',
      },
    });
  }

  if (pr !== undefined) {
    if (query.includes('commits('))
      return repository({ pullRequest: { commits: page(pr.commits) } });

    if (query.includes('timelineItems'))
      return repository({ pullRequest: { timelineItems: page(pr.timeline) } });

    return repository({
      pullRequest: {
        number,
        createdAt: time(pr.createdAt),
        author: { login: pr.author },
        headRefOid: pr.head,
        mergeable: 'MERGEABLE',
        mergeCommit: pr.mergeCommit === null ? null : { oid: pr.mergeCommit },
      },
    });
  }

  return NOT_FOUND;
}

function answerRest(path: string, reverse: boolean, runsTotal: number): Answer {
  const order = (list: Json[]): Json[] => (reverse ? [...list].reverse() : list);

  if (path === '/repos/o/r/actions/workflows/deploy.yml/runs')
    return { body: { workflow_runs: [{ head_sha: DEPLOY, updated_at: time(230) }] } };

  if (path === '/repos/o/r/actions/runs') {
    return {
      body: {
        total_count: runsTotal,
        workflow_runs: order([
          {
            display_title: 'CI',
            event: 'workflow_dispatch',
            status: 'completed',
            created_at: time(60),
            run_started_at: time(60),
            updated_at: time(70),
          },
          // A pull request's CI, titled by a stranger like an Executor run.
          {
            display_title: 'review #40 bbbbbbb',
            event: 'pull_request',
            status: 'completed',
            created_at: time(150),
            run_started_at: time(150),
            updated_at: time(160),
          },
        ]),
      },
    };
  }

  if (path === '/repos/o/r/commits')
    return { body: [{ sha: MAIN, commit: { committer: { date: time(-100) } } }] };

  if (path === `/repos/o/r/compare/${MERGE}...${DEPLOY}`) return { body: { status: 'ahead' } };

  const perCommit = /^\/repos\/o\/r\/commits\/([0-9a-f]{40})\/(check-runs|statuses)$/.exec(path);

  if (perCommit !== null) {
    const [, commit = '', kind = ''] = perCommit;

    const pr = [...PULL_REQUESTS.values()].find(
      (candidate) => candidate.checks[commit] !== undefined,
    );

    if (pr === undefined) return NOT_FOUND;

    return kind === 'check-runs'
      ? { body: { check_runs: order(pr.checks[commit] ?? []) } }
      : { body: order(pr.statuses[commit] ?? []) };
  }

  const comments = /^\/repos\/o\/r\/issues\/([0-9]+)\/comments$/.exec(path)?.[1];

  if (comments !== undefined) {
    const number = Number(comments);

    return { body: ISSUES.get(number)?.comments ?? PULL_REQUESTS.get(number)?.comments ?? [] };
  }

  return NOT_FOUND;
}

/**
 * A stand-in GitHub; `reverse` answers every list GitHub doesn't order in the other order,
 * `runsTotal` is the `total_count` of the runs list, and every request's URL goes in `requests`.
 */
function fakeGitHub(reverse = false, runsTotal = 2, requests: URL[] = []): GitHub {
  const fakeFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);

    requests.push(url);

    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token');

    let answer: Answer;

    if (url.pathname === '/graphql') {
      const request = new Read(parseJson(String(init?.body), 'request'), 'request');

      answer = answerGraphql(
        request.field('query').text(),
        request.field('variables').field('number').number(),
      );
    } else {
      answer = answerRest(url.pathname, reverse, runsTotal);
    }

    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  };

  return { fetch: fakeFetch, token: 'token', repository: 'o/r' };
}

async function gathered(number: number, github = fakeGitHub()): Promise<RawWorkItem> {
  const item = await gatherWorkItem(github, number);

  assert.ok(!('unreadable' in item), `#${number} should be readable`);

  return item;
}

/** Runs `main` against the stand-in GitHub, keeping what it saves and says. */
async function run(
  args: string[],
  github = fakeGitHub(),
  env: Io['env'] = { GH_TOKEN: 'token', GITHUB_REPOSITORY: 'o/r' },
): Promise<{ code: number; saved: Map<number, string>; out: string[]; err: string[] }> {
  const saved = new Map<number, string>();
  const out: string[] = [];
  const err: string[] = [];

  const code = await main(args, {
    fetch: github.fetch,
    env,
    now: () => new Date(time(300)),
    save: async (number, text) => {
      saved.set(number, text);
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });

  return { code, saved, out, err };
}

const nextAt = (checkpoints: readonly Checkpoint[], minutes: number): Checkpoint['next'] => {
  const found = checkpoints.find((checkpoint) => checkpoint.at === time(minutes));

  assert.ok(found !== undefined, `no checkpoint at ${time(minutes)}`);

  return found.next;
};

const actionAt = (checkpoints: readonly Checkpoint[], minutes: number): Action | 'unknown' => {
  const next = nextAt(checkpoints, minutes);

  return 'unknown' in next ? 'unknown' : next.action;
};

const startAction = (
  executor: 'build' | 'ci-fix' | 'review',
  head: string | null,
  attempt: number | null,
): Action => ({ type: 'start', executor, item: 40, head, attempt, minor: false });

test('record writes history/<n>.json for each Work item: the raw answers and the checkpoints', async () => {
  const { code, saved, out } = await run(['record', '40', '50']);

  assert.equal(code, 0);
  assert.deepEqual([...saved.keys()], [40, 50]);
  assert.deepEqual(out, ['#40: recorded, 15 checkpoints', '#50: recorded, 8 checkpoints']);

  const fixture = parseFixture(saved.get(40) ?? '', '40.json');

  assert.equal(fixture.gather, GATHER_VERSION);
  // What act reads now isn't history.
  assert.equal(saved.get(40)?.includes('"surface"'), false);
  assert.deepEqual(fixture.raw, JSON.parse(JSON.stringify(fixtureOf(await gathered(40)).raw)));
});

test('the raw answers are what gather returns, trimmed as gather trims them', async () => {
  const fixture = fixtureOf(await gathered(40));
  const raw = new Read(JSON.parse(serialize(fixture)), 'fixture').field('raw');

  assert.equal(raw.field('pullRequest').field('number').number(), 41);
  // Every commit's checks, for the past heads.
  assert.deepEqual(
    raw
      .field('checks')
      .items()
      .map((entry) => entry.field('sha').text()),
    [C1, C2],
  );
  // The marker comments cut to their marker, heading and footer; the stranger's left out.
  assert.deepEqual(
    raw
      .field('comments')
      .items()
      .map((entry) => entry.field('body').text()),
    [
      '<!-- factory-ci-fix -->\n### CI fix, attempt 1 of 2: pushed a fix\n<sub>[Run](x), for commit aaaaaaa. ADR-0028.</sub>',
      '<!-- factory-review -->\n### Factory review: ✅ Ready for you\n<sub>Commit bbbbbbb, reviewed by the factory.</sub>',
    ],
  );
  // Only the dispatcher's own comments on the Ticket.
  assert.equal(raw.field('ticket').field('comments').items().length, 2);
  // Executor runs from the day before the Ticket was opened, a collaborator's only.
  assert.deepEqual(raw.field('runs').json(), []);

  const text = serialize(fixture);

  for (const left of ['What the fixer did', 'The review.', 'what the Owner asked', 'html_url'])
    assert.equal(text.includes(left), false, `${left} is in the fixture`);
});

test('a checkpoint at every event in its life, each with its time', async () => {
  const fixture = fixtureOf(await gathered(40));

  assert.deepEqual(
    fixture.checkpoints.map((checkpoint) => [checkpoint.at, checkpoint.events]),
    [
      [time(-500), ['Ticket: description edited by o']],
      [time(0), ['Ticket: `ready` added by o']],
      [time(1), ['Ticket: the dispatcher commented']],
      [
        time(30),
        ['Ticket: `building` added by github-actions', 'Ticket: the dispatcher commented'],
      ],
      [time(50), ['push: aaaaaaa by claude']],
      [
        time(55),
        ['pull request #41 opened by claude', 'pull request: `factory` added by github-actions'],
      ],
      [time(60), ['check: check ended failure on aaaaaaa']],
      [time(70), ['push: bbbbbbb by claude']],
      [time(71), ['comment: <!-- factory-ci-fix -->']],
      [time(79), ['check: CodeQL ended success on bbbbbbb']],
      [time(80), ['check: check ended success on bbbbbbb']],
      [time(90), ['comment: <!-- factory-review -->']],
      [time(120), ['comment: the Owner mentioned `@claude`']],
      [time(200), ['Ticket: closed', 'pull request: merged']],
      [time(230), ['deploy: eeeeeee includes ccccccc']],
    ],
  );
});

test("each checkpoint has the step the factory took next, as decide's actions", async () => {
  const { checkpoints } = fixtureOf(await gathered(40));

  // The Owner's edit: the factory waited for their `ready`.
  assert.deepEqual(actionAt(checkpoints, -500), { type: 'nothing' });
  // The dispatcher queued it: it said so before it started anything.
  assert.deepEqual(actionAt(checkpoints, 0), { type: 'nothing' });
  // Then it labeled it `building`: start the build.
  assert.deepEqual(actionAt(checkpoints, 1), startAction('build', null, 1));
  // CI failed on the first commit: the CI fixer's push and comment show it started.
  assert.deepEqual(actionAt(checkpoints, 60), startAction('ci-fix', C1, 1));
  // CI passed on the fix: the `factory` status shows the reviewer starting.
  assert.deepEqual(actionAt(checkpoints, 80), startAction('review', C2, null));
  // A ready Review: nothing until the Owner acted.
  assert.deepEqual(nextAt(checkpoints, 90), {
    action: { type: 'nothing' },
    evidence: `The factory did nothing until the Owner acted: comment: the Owner mentioned \`@claude\` at ${time(120)}.`,
  });
  // Merged and Deployed: nothing more.
  assert.deepEqual(actionAt(checkpoints, 200), { type: 'nothing' });
  assert.deepEqual(actionAt(checkpoints, 230), { type: 'nothing' });
});

test("a hand-over is the factory's `needs-human`, and a rerun is a check run again", async () => {
  const { checkpoints } = fixtureOf(await gathered(50));

  assert.deepEqual(actionAt(checkpoints, 10), { type: 'rerun', head: F1, checks: ['check'] });
  // A skipped check started again is another event's workflow skipping its job, not a rerun.
  assert.deepEqual(actionAt(checkpoints, 2), { type: 'nothing' });
  assert.deepEqual(actionAt(checkpoints, 3), { type: 'nothing' });
  assert.deepEqual(actionAt(checkpoints, 40), {
    type: 'hand-over',
    reason: `pull request: \`needs-human\` added by github-actions at ${time(60)}`,
  });
  // Handed over: the Owner took it back.
  assert.deepEqual(actionAt(checkpoints, 60), { type: 'nothing' });
});

test("a withdrawal is the factory taking the Owner's `ready` off", async () => {
  const { checkpoints } = fixtureOf(await gathered(60));

  assert.deepEqual(actionAt(checkpoints, 10), {
    type: 'withdraw',
    reason: `Ticket: \`ready\` removed by github-actions at ${time(20)}`,
  });
});

test('a checkpoint where the Ticket waited behind others records them as building', async () => {
  const { checkpoints } = fixtureOf(await gathered(40));

  assert.deepEqual(
    checkpoints.map((checkpoint) => [checkpoint.at, checkpoint.building]),
    checkpoints.map((checkpoint) => [checkpoint.at, checkpoint.at === time(1) ? [30] : []]),
  );
});

test("a checkpoint the events don't settle is unknown, with why", async () => {
  const { checkpoints } = fixtureOf(await gathered(40));

  // The build ran from its `building` label to the pull request; nothing recorded shows decide it ran.
  assert.match(
    String(Object.values(nextAt(checkpoints, 50))[0]),
    /^The build was running then \(from .+ to .+\)/,
  );
  assert.equal(actionAt(checkpoints, 30), 'unknown');
  // The CI fixer's own push, before its comment.
  assert.equal(actionAt(checkpoints, 70), 'unknown');
  // CI failed after the pull request opened, and the fixer's work came after that.
  assert.equal(actionAt(checkpoints, 55), 'unknown');
  // A mention is answered by a run that leaves no comment.
  assert.equal(actionAt(checkpoints, 120), 'unknown');

  for (const checkpoint of checkpoints) {
    if ('unknown' in checkpoint.next) assert.notEqual(checkpoint.next.unknown, '');
  }
});

test("a mention is answered only by a mention run after it, not by another Executor's", async () => {
  const raw = await gathered(40);

  const executorRun = (title: string, minutes: number): Json => ({
    display_title: title,
    event: 'workflow_dispatch',
    status: 'completed',
    created_at: time(minutes),
    run_started_at: time(minutes),
    updated_at: time(minutes + 5),
  });

  const review = executorRun('review #40 bbbbbbb', 130);

  assert.equal(actionAt(checkpointsOf({ ...raw, runs: [review] }), 120), 'unknown');

  assert.deepEqual(
    actionAt(
      checkpointsOf({ ...raw, runs: [executorRun('mention #40 bbbbbbb', 121), review] }),
      120,
    ),
    { type: 'start', executor: 'mention', item: 40, head: C2, attempt: null, minor: false },
  );
});

test("the runs read are those of the Work item's life, from the day before it opened until it closed", async () => {
  const requests: URL[] = [];

  await gathered(40, fakeGitHub(false, 2, requests));

  const runs = requests.find((url) => url.pathname === '/repos/o/r/actions/runs');

  assert.equal(runs?.searchParams.get('created'), `${time(-600 - 24 * 60)}..${time(200)}`);
});

test('a run list GitHub cut short is refused, not recorded without its oldest runs', async () => {
  const item = await gatherWorkItem(fakeGitHub(false, 1001), 40);

  assert.ok('unreadable' in item);
  assert.match(item.unreadable, /listed 2 of the 1001 runs .+ the oldest are missing/);
});

test("a User report's Ticket keeps only its labels and events, not its text", async () => {
  const { code, saved } = await run(['record', '60']);

  assert.equal(code, 0);

  const text = saved.get(60) ?? '';

  assert.ok(text.includes('user-report'));

  for (const secret of ['private title', 'private words', 'User report:'])
    assert.equal(text.includes(secret), false, `${secret} is in the fixture`);
});

test('a fixture that matches a credential pattern is refused', async () => {
  const raw = await gathered(50);
  const token = `ghp_${'A1'.repeat(18)}`;
  const leaky: RawWorkItem = { ...raw, owner: token };

  assert.throws(() => serialize(fixtureOf(leaky)), /matches a credential pattern/);
  assert.equal(credentialIn(serialize(fixtureOf(raw))), null);
});

test("the credential patterns are guard-secrets.sh's", () => {
  const guard = readFileSync(
    new URL('../../.github/factory/guard-secrets.sh', import.meta.url),
    'utf8',
  );

  for (const pattern of CREDENTIAL_PATTERNS)
    assert.ok(guard.includes(`'${pattern.source}'`), `${pattern.source} isn't in guard-secrets.sh`);

  assert.equal(guard.match(/^ {2}'/gm)?.length, CREDENTIAL_PATTERNS.length);
});

test('every recorded fixture holds no credential and was recorded by this gather', () => {
  const history = new URL('history/', import.meta.url);
  const files = existsSync(history) ? readdirSync(history).filter((f) => f.endsWith('.json')) : [];

  for (const file of files) {
    const text = readFileSync(new URL(file, history), 'utf8');

    assert.equal(credentialIn(text), null, `${file} matches a credential pattern`);
    parseFixture(text, file);
  }
});

test('the same Work item recorded twice with nothing new is byte for byte the same', async () => {
  const first = await run(['record', '40', '50']);
  const again = await run(['record', '40', '50'], fakeGitHub(true));

  assert.equal(again.saved.get(40), first.saved.get(40));
  assert.equal(again.saved.get(50), first.saved.get(50));

  const text = first.saved.get(40) ?? '';

  assert.ok(text.endsWith('}\n'));
  assert.ok(text.indexOf('"checkpoints"') < text.indexOf('"gather"'), 'keys are sorted');
});

test('a fixture from another gather version is refused, with how to record it again', async () => {
  const fixture: Fixture = { ...fixtureOf(await gathered(50)), gather: GATHER_VERSION + 1 };

  assert.throws(
    () => parseFixture(serialize(fixture), '50.json'),
    (error: Error) =>
      error.message ===
      `50.json was recorded with gather version ${GATHER_VERSION + 1}, and gather is version ${GATHER_VERSION} now: record it again with \`node tools/conductor/main.ts record 50\`.`,
  );
});

test('a fixture reads back as it was written', async () => {
  const fixture = fixtureOf(await gathered(40));

  assert.deepEqual(parseFixture(serialize(fixture), '40.json'), JSON.parse(serialize(fixture)));
});

test("a Work item GitHub can't answer about is not recorded, and the rest still are", async () => {
  const { code, saved, err } = await run(['record', '41', '99', '50']);

  assert.equal(code, 1);
  assert.deepEqual([...saved.keys()], [50]);
  assert.deepEqual(err, [
    '#41: not recorded: #41 is the pull request of #40: record its Ticket instead',
    '#99: not recorded: GitHub refused issue or pull request #99: Could not resolve to an issue or pull request #99',
  ]);
});

test('record needs a token, a repository and numbers', async () => {
  assert.equal((await run(['record', '40'], fakeGitHub(), {})).code, 2);
  assert.equal((await run(['record'])).code, 2);
  assert.equal((await run(['record', 'abc'])).code, 2);
  assert.equal((await run(['nonsense'])).code, 2);
});
