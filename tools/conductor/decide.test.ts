// decide(states, policy): each case is one base state and one change to it, as test-dispatch.sh's
// are. The time is 12:00 on 2026-11-20; other times are minutes before it.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type Decision, STATES, decide } from './decide.ts';
import { type Policy, policy } from './policy.ts';
import { type RunKind, makeRunName } from './run-name.ts';
import type {
  ActiveRun,
  BlockerState,
  CheckState,
  Fact,
  FinishedRun,
  PullRequestState,
  Ready,
  Review,
  RunsState,
  TicketState,
  WorkItemState,
} from './state.ts';

const AT = '2026-11-20T12:00:00.000Z';

const ago = (minutes: number): string => new Date(Date.parse(AT) - minutes * 60_000).toISOString();

const known = <T>(value: T): Fact<T> => ({ known: true, value });

const unknown: Fact<never> = { known: false, missing: 'it was not gathered' };

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const MAIN = 'fedcba9876543210fedcba9876543210fedcba98';

/** The Owner's Approval an hour ago. */
const approval: Ready = {
  by: 'o',
  at: ago(60),
  approved: true,
  nightly: false,
  since: ago(60),
  voided: false,
};

/** A ready Ticket the Owner approved, nothing blocking it, never built. */
const ticket = (patch: Partial<TicketState> = {}): TicketState => ({
  number: 10,
  open: true,
  closed: null,
  labels: ['ready'],
  ready: approval,
  held: null,
  answered: false,
  building: null,
  blockers: known([]),
  ...patch,
});

/** A Ticket the factory started building two hours ago. */
const building = (patch: Partial<TicketState> = {}): TicketState =>
  ticket({ labels: ['ready', 'building'], building: { since: ago(120) }, ...patch });

const blocker = (number: number, patch: Partial<BlockerState> = {}): BlockerState => ({
  number,
  status: 'open',
  deployed: known(false),
  held: null,
  labels: ['ready'],
  ...patch,
});

const runs = (patch: Partial<RunsState> = {}): RunsState => ({
  active: [],
  finished: [],
  startedLastDay: { item: 0, all: 0 },
  ...patch,
});

const SHA7 = HEAD.slice(0, 7);

/** A run of this Work item's that finished, asked for `minutes` ago: for HEAD, or before a pull request. */
const finished = (kind: RunKind, minutes: number): FinishedRun => {
  const sha = kind === 'build' ? null : SHA7;

  return { name: makeRunName({ kind, item: 10, sha }), kind, sha, createdAt: ago(minutes) };
};

const active = (kind: RunKind, status: ActiveRun['status'] = 'in_progress'): ActiveRun => {
  const sha = kind === 'build' ? null : SHA7;

  return { name: makeRunName({ kind, item: 10, sha }), kind, sha, status };
};

const passed = (patch: Partial<CheckState> = {}): CheckState => ({
  name: 'check',
  status: 'completed',
  conclusion: 'success',
  startedAt: ago(20),
  completedAt: ago(10),
  runs: 1,
  ...patch,
});

const ready: Review = { verdict: 'ready', commit: HEAD, at: ago(5), minor: 0 };

/** The factory's open pull request on HEAD: CI passed, and a ready Review of HEAD. */
const pullRequest = (patch: Partial<PullRequestState> = {}): PullRequestState => ({
  number: 11,
  author: 'claude',
  status: 'open',
  merged: null,
  labels: ['factory'],
  head: known(HEAD),
  headAt: known(ago(30)),
  dependabotOnly: false,
  mention: known(null),
  mergeable: known('MERGEABLE'),
  checks: known([passed()]),
  statuses: known([]),
  attempts: known({ since: null, ciFix: 0, rework: 0, minorPasses: 0, conflict: [] }),
  review: known(ready),
  ...patch,
});

const item = (patch: Partial<WorkItemState> = {}): WorkItemState => ({
  number: 10,
  at: AT,
  ticket: known(ticket()),
  pullRequest: known(null),
  runs: known(runs()),
  main: known(MAIN),
  ...patch,
});

/** Ticket #10 being built, with its pull request changed by `patch`. */
const onPr = (patch: Partial<PullRequestState> = {}, rest: Partial<WorkItemState> = {}) =>
  item({ ticket: known(building()), pullRequest: known(pullRequest(patch)), ...rest });

/** A pull request with no Ticket, like Dependabot's. */
const alone = (patch: Partial<PullRequestState> = {}, rest: Partial<WorkItemState> = {}) =>
  item({ number: 11, ticket: known(null), pullRequest: known(pullRequest(patch)), ...rest });

const OWNERS_TURN = ['needs-human', 'needs-info', 'reviewed'];

/** Every decision's reason is one plain sentence, and says what the Owner can do on their turn. */
function checked(decisions: readonly Decision[]): Decision[] {
  for (const decision of decisions) {
    assert.ok(STATES.includes(decision.state), `${decision.state} is a state`);
    assert.match(decision.reason, /^[A-Z#`].*\.$/s, `one sentence: ${decision.reason}`);
    assert.doesNotMatch(decision.reason, /[.!?]\s/, `one sentence: ${decision.reason}`);

    if (
      OWNERS_TURN.includes(decision.state) ||
      decision.action.type === 'hand-over' ||
      decision.action.type === 'withdraw'
    ) {
      assert.match(decision.reason, /\byou/i, `says what the Owner can do: ${decision.reason}`);
    }
  }

  return [...decisions];
}

const all = (states: readonly WorkItemState[], rules: Policy = policy): Decision[] =>
  checked(decide(states, rules));

function one(state: WorkItemState, rules: Policy = policy): Decision {
  const [decision] = all([state], rules);

  assert.ok(decision !== undefined);

  return decision;
}

/** The state and the action's type, or the Executor it starts. */
function outcome(decision: Decision): string {
  const action =
    decision.action.type === 'start' ? `start ${decision.action.executor}` : decision.action.type;

  return `${decision.state}: ${action}`;
}

const expect = (state: WorkItemState, expected: string, rules: Policy = policy) =>
  assert.equal(outcome(one(state, rules)), expected);

const withTicket = (patch: Partial<TicketState>) => item({ ticket: known(ticket(patch)) });

describe("a Ticket before its pull request: dispatch.sh's cases", () => {
  test('unblocked, nothing in flight: start its first build', () => {
    const decision = one(item());

    assert.deepEqual(decision.action, {
      type: 'start',
      executor: 'build',
      item: 10,
      head: null,
      attempt: 1,
      minor: false,
    });
    assert.equal(decision.state, 'building');
  });

  test("labeled by someone other than the Owner, or not labeled: it waits, and isn't started", () => {
    expect(
      withTicket({ ready: { ...approval, by: 'someone', approved: false, since: null } }),
      'waiting: nothing',
    );
    expect(withTicket({ ready: null, labels: [] }), 'waiting: nothing');
  });

  test('labeled needs-human, or waiting for answers: held for the Owner', () => {
    expect(withTicket({ held: 'needs-human' }), 'needs-human: nothing');
    expect(withTicket({ held: 'needs-info' }), 'needs-info: nothing');
  });

  test('needs-info answered and labeled ready again: start', () => {
    expect(
      withTicket({ labels: ['ready', 'needs-info'], answered: true }),
      'building: start build',
    );
  });

  test('edited by someone else after the Approval: withdraw it, even when also blocked', () => {
    const voided = { ...approval, voided: true };
    const decision = one(withTicket({ ready: voided }));

    assert.equal(outcome(decision), 'waiting: withdraw');
    assert.deepEqual(decision.action, { type: 'withdraw', reason: decision.reason });
    expect(withTicket({ ready: voided, blockers: known([blocker(3)]) }), 'waiting: withdraw');
  });

  test('a Blocker open, or merged but not Deployed: wait, naming only those', () => {
    const decision = one(
      withTicket({
        blockers: known([blocker(3), blocker(4, { status: 'merged', deployed: known(true) })]),
      }),
    );

    assert.equal(outcome(decision), 'waiting: nothing');
    assert.match(decision.reason, /#3, until each is merged and Deployed/);
    assert.doesNotMatch(decision.reason, /#4/);
    expect(
      withTicket({ blockers: known([blocker(3, { status: 'merged', deployed: known(false) })]) }),
      'waiting: nothing',
    );
  });

  test('every Blocker Deployed: start', () => {
    expect(
      withTicket({
        blockers: known([
          blocker(3, { status: 'merged', deployed: known(true) }),
          blocker(4, { status: 'merged', deployed: known(true) }),
        ]),
      }),
      'building: start build',
    );
  });

  test('a Blocker closed without a merged pull request: hand over, even beside an open one', () => {
    const unmerged = blocker(4, { status: 'unmerged' });
    const decision = one(withTicket({ blockers: known([unmerged]) }));

    assert.equal(outcome(decision), 'needs-human: hand-over');
    assert.match(decision.reason, /#4 closed without a merged pull request/);
    expect(withTicket({ blockers: known([blocker(3), unmerged]) }), 'needs-human: hand-over');
  });

  test('a Blocker held for the Owner is named with its label; one nothing will finish is named too', () => {
    const decision = one(
      withTicket({
        blockers: known([
          blocker(3, { held: 'needs-human', labels: ['needs-human'] }),
          blocker(5, { labels: [] }),
          blocker(6, { labels: ['building'] }),
        ]),
      }),
    );

    assert.match(decision.reason, /#3 \(`needs-human`\) waits on you/);
    assert.match(decision.reason, /nothing will finish #5,/);
    assert.doesNotMatch(decision.reason, /finish #3|finish #5, #6|finish #6/);
  });

  test('another Ticket in flight: wait behind it; blocked as well: the Blocker is the reason', () => {
    const other = item({
      number: 7,
      ticket: known(building({ number: 7 })),
      runs: known(runs({ active: [active('build')] })),
    });

    const [, queued] = all([other, item()]);

    assert.equal(queued && outcome(queued), 'waiting: nothing');
    assert.match(queued?.reason ?? '', /#7 is in flight/);

    const [, blocked] = all([other, withTicket({ blockers: known([blocker(3)]) })]);

    assert.match(blocked?.reason ?? '', /blocked by #3/);
  });

  test('building, just started: building, nothing more', () => {
    expect(
      item({ ticket: known(building({ building: { since: ago(10) } })) }),
      'building: nothing',
    );
  });

  test('building for over the stale build time with no run and no pull request: hand over', () => {
    expect(
      item({ ticket: known(building({ building: { since: ago(91) } })) }),
      'needs-human: hand-over',
    );
  });

  test('building and handed to a human: held', () => {
    expect(item({ ticket: known(building({ held: 'needs-human' })) }), 'needs-human: nothing');
  });

  test('closed and merged: merged until Deployed, then deployed; closed by hand: nothing left', () => {
    const closed = (deployed: boolean) =>
      item({
        ticket: known(
          building({
            open: false,
            closed: { merged: true, commit: 'm1', at: ago(30), deployed: known(deployed) },
          }),
        ),
      });

    expect(closed(false), 'merged: nothing');
    expect(closed(true), 'deployed: nothing');
    expect(
      item({
        ticket: known(
          building({
            open: false,
            closed: { merged: false, commit: null, at: ago(30), deployed: known(false) },
          }),
        ),
      }),
      'deployed: nothing',
    );
  });

  test("one at a time: the Owner's Tickets before Mutation tickets, each oldest Approval first", () => {
    const nightly = item({
      number: 47,
      ticket: known(
        ticket({
          number: 47,
          ready: { ...approval, by: 'github-actions', nightly: true, at: ago(300) },
        }),
      ),
    });

    const older = item({
      number: 20,
      ticket: known(ticket({ number: 20, ready: { ...approval, at: ago(120) } })),
    });

    const newer = item({
      number: 21,
      ticket: known(ticket({ number: 21, ready: { ...approval, at: ago(30) } })),
    });

    const decisions = all([nightly, newer, older]);

    assert.deepEqual(
      decisions.map((decision) => [decision.number, outcome(decision)]),
      [
        [47, 'waiting: nothing'],
        [21, 'waiting: nothing'],
        [20, 'building: start build'],
      ],
    );
    assert.match(decisions[0]?.reason ?? '', /starts #20 first/);
  });
});

describe('what ADR-0075 changes', () => {
  test('a Work item in needs-human holds nothing: another Ticket starts, and the Tickets it blocks still wait', () => {
    const handedOver = onPr(
      { labels: ['factory', 'needs-human'] },
      { number: 7, ticket: known(building({ number: 7 })) },
    );

    const decisions = all([
      handedOver,
      item(),
      item({
        number: 12,
        ticket: known(
          ticket({
            number: 12,
            ready: { ...approval, at: ago(10) },
            blockers: known([blocker(7, { labels: ['building'] })]),
          }),
        ),
      }),
    ]);

    assert.deepEqual(
      decisions.map((decision) => [decision.number, outcome(decision)]),
      [
        [7, 'needs-human: nothing'],
        [10, 'building: start build'],
        [12, 'waiting: nothing'],
      ],
    );
    assert.match(decisions[2]?.reason ?? '', /blocked by #7/);
  });

  test('a waiting-for-answers Ticket holds nothing either', () => {
    const waitingForAnswers = item({
      number: 7,
      ticket: known(
        building({ number: 7, held: 'needs-info', labels: ['building', 'needs-info'] }),
      ),
    });

    assert.deepEqual(all([waitingForAnswers, item()]).map(outcome), [
      'needs-info: nothing',
      'building: start build',
    ]);
  });

  test("a build that ended without a pull request is started again, and handed over after the policy's two", () => {
    const failed = (count: number) =>
      item({
        ticket: known(building()),
        runs: known(
          runs({ finished: Array.from({ length: count }, () => finished('build', 100)) }),
        ),
      });

    const again = one(failed(1));

    assert.equal(outcome(again), 'building: start build');
    assert.equal(again.action.type === 'start' && again.action.attempt, 2);
    expect(failed(2), 'needs-human: hand-over');
    expect(failed(2), 'building: start build', { ...policy, builds: 3 });

    // A build from before it was last labeled `building` (the Owner handed it back) doesn't count.
    expect(
      item({
        ticket: known(building({ building: { since: ago(10) } })),
        runs: known(runs({ finished: [finished('build', 100), finished('build', 90)] })),
      }),
      'building: nothing',
    );
  });

  test("a merge not Deployed after the policy's 3 hours is handed over, naming the merge commit", () => {
    const merged = (minutes: number) =>
      onPr({
        status: 'merged',
        merged: { at: ago(minutes), commit: 'c0ffee1234567', deployed: known(false) },
      });

    expect(merged(179), 'merged: nothing');

    const late = one(merged(180));

    assert.equal(outcome(late), 'needs-human: hand-over');
    assert.match(late.reason, /c0ffee1/);
    expect(merged(180), 'merged: nothing', { ...policy, undeployedMinutes: 240 });
  });
});

describe("a pull request: attempt.sh's and sweep-prs.sh's cases", () => {
  const attempts = (
    patch: Partial<{
      ciFix: number;
      rework: number;
      minorPasses: number;
      conflict: { main: string; count: number }[];
    }>,
  ) => known({ since: null, ciFix: 0, rework: 0, minorPasses: 0, conflict: [], ...patch });

  const failure = passed({ conclusion: 'failure' });

  test('CI failed: the CI fixer, two Attempts since the last human push, then a hand-over', () => {
    const first = one(onPr({ checks: known([failure]) }));

    assert.equal(outcome(first), 'fixing: start ci-fix');
    assert.deepEqual(first.action, {
      type: 'start',
      executor: 'ci-fix',
      item: 10,
      head: HEAD,
      attempt: 1,
      minor: false,
    });
    expect(
      onPr({ checks: known([failure]), attempts: attempts({ ciFix: 1 }) }),
      'fixing: start ci-fix',
    );
    expect(
      onPr({ checks: known([failure]), attempts: attempts({ ciFix: 2 }) }),
      'needs-human: hand-over',
    );
  });

  test("the CI fixer has answered this failure: wait, then hand over after the sweeper's threshold", () => {
    const fixed = (failedAgo: number) =>
      onPr(
        {
          checks: known([passed({ conclusion: 'failure', completedAt: ago(failedAgo) })]),
          attempts: attempts({ ciFix: 1 }),
        },
        { runs: known(runs({ finished: [finished('ci-fix', failedAgo - 1)] })) },
      );

    expect(fixed(30), 'fixing: nothing');
    expect(fixed(121), 'needs-human: hand-over');
  });

  test('the reviewer asked for changes: Rework, two Attempts, then a hand-over', () => {
    const changes = known({ ...ready, verdict: 'changes' as const });

    expect(onPr({ review: changes }), 'reworking: start rework');
    expect(onPr({ review: changes, attempts: attempts({ rework: 1 }) }), 'reworking: start rework');
    expect(onPr({ review: changes, attempts: attempts({ rework: 2 }) }), 'needs-human: hand-over');
  });

  test('Rework has answered the changes: wait, then hand over after the threshold', () => {
    const answered = (reviewedAgo: number) =>
      onPr(
        { review: known({ ...ready, verdict: 'changes' as const, at: ago(reviewedAgo) }) },
        { runs: known(runs({ finished: [finished('rework', reviewedAgo - 1)] })) },
      );

    expect(answered(30), 'reworking: nothing');
    expect(answered(121), 'needs-human: hand-over');
  });

  test("a ready Review with minor findings gets the one Minor pass, not an Attempt; after it, the Owner's turn", () => {
    const minor = known({ ...ready, minor: 2 });
    const pass = one(onPr({ review: minor }));

    assert.equal(outcome(pass), 'reworking: start rework');
    assert.equal(pass.action.type === 'start' && pass.action.minor, true);
    assert.equal(pass.action.type === 'start' && pass.action.attempt, null);
    expect(onPr({ review: minor, attempts: attempts({ minorPasses: 1 }) }), 'reviewed: nothing');
    expect(onPr({ review: minor, labels: ['autofix'] }), 'reviewed: nothing');
  });

  test("a ready Review of the head: the Owner's turn", () => {
    expect(onPr(), 'reviewed: nothing');
  });

  test('a conflict: the resolver, counted per commit of main', () => {
    const conflicting = (conflict: { main: string; count: number }[]) =>
      onPr({ mergeable: known('CONFLICTING'), attempts: attempts({ conflict }) });

    expect(conflicting([]), 'resolving: start conflict');
    expect(conflicting([{ main: MAIN.slice(0, 7), count: 2 }]), 'needs-human: hand-over');
    expect(conflicting([{ main: 'aaaaaaa', count: 2 }]), 'resolving: start conflict');

    const second = one(conflicting([{ main: MAIN.slice(0, 7), count: 1 }]));

    assert.equal(second.action.type === 'start' && second.action.attempt, 2);
  });

  test("a conflict on a pull request that isn't the factory's: hand over", () => {
    expect(
      onPr({ mergeable: known('CONFLICTING'), labels: ['autofix'] }),
      'needs-human: hand-over',
    );
  });

  test('mergeability unknown: not resolving, it waits for GitHub to compute it', () => {
    const decision = one(onPr({ mergeable: known('UNKNOWN') }));

    assert.equal(outcome(decision), 'checking: nothing');
    assert.match(decision.reason, /GitHub is still working out/);
  });

  test('a cancelled check is rerun once, then handed over', () => {
    const cancelled = passed({ name: 'e2e', conclusion: 'cancelled' });
    const rerun = one(onPr({ checks: known([passed(), cancelled]) }));

    assert.equal(outcome(rerun), 'checking: rerun');
    assert.deepEqual(rerun.action, { type: 'rerun', head: HEAD, checks: ['e2e'] });
    expect(onPr({ checks: known([{ ...cancelled, runs: 2 }]) }), 'needs-human: hand-over');
  });

  test("CI that hasn't started: wait, then hand over after the sweeper's 30 minutes", () => {
    expect(onPr({ checks: known([]), headAt: known(ago(10)) }), 'checking: nothing');
    expect(onPr({ checks: known([]), headAt: known(ago(31)) }), 'needs-human: hand-over');
  });

  test('CI running: wait, then hand over after 90 minutes', () => {
    const running = (minutes: number) =>
      onPr({
        checks: known([
          passed({
            status: 'in_progress',
            conclusion: null,
            completedAt: null,
            startedAt: ago(minutes),
          }),
        ]),
      });

    expect(running(10), 'checking: nothing');
    expect(running(91), 'needs-human: hand-over');
  });

  test('CI passed and no Review of the head: start the reviewer; it ran and left none: hand over after 60 minutes', () => {
    const older = known({ ...ready, commit: '1234567' });

    expect(onPr({ review: older }), 'reviewing: start review');
    expect(onPr({ review: known(null) }), 'reviewing: start review');

    const reviewed = (passedAgo: number) =>
      onPr(
        { review: known(null), checks: known([passed({ completedAt: ago(passedAgo) })]) },
        { runs: known(runs({ finished: [finished('review', passedAgo - 1)] })) },
      );

    expect(reviewed(30), 'reviewing: nothing');
    expect(reviewed(61), 'needs-human: hand-over');
  });

  test("a pull request whose head can't be read waits", () => {
    expect(onPr({ head: unknown }), 'checking: nothing');
  });
});

describe('Executors, the budget and mentions', () => {
  test('an Executor queued or running: nothing more starts, and the state names it', () => {
    const running = (kind: RunKind, state: WorkItemState) =>
      outcome(one({ ...state, runs: known(runs({ active: [active(kind, 'queued')] })) }));

    assert.equal(running('build', item()), 'building: nothing');
    assert.equal(running('ci-fix', onPr()), 'fixing: nothing');
    assert.equal(running('review', onPr()), 'reviewing: nothing');
    assert.equal(running('rework', onPr()), 'reworking: nothing');
    assert.equal(running('conflict', onPr()), 'resolving: nothing');
  });

  test("a running mention keeps the pull request's state, and says it's running", () => {
    const decision = one(onPr({}, { runs: known(runs({ active: [active('mention')] })) }));

    assert.equal(outcome(decision), 'reviewed: nothing');
    assert.match(decision.reason, /mention Executor/);
  });

  test("at or past the dispatch budget, its own or everyone's: it starts nothing and says so, without a hand-over", () => {
    const spent = (item: number, all: number) =>
      one({
        ...onPr({ review: known(null) }),
        runs: known(runs({ startedLastDay: { item, all } })),
      });

    assert.equal(outcome(spent(19, 59)), 'reviewing: start review');

    for (const decision of [spent(20, 20), spent(1, 60)]) {
      assert.equal(outcome(decision), 'reviewing: nothing');
      assert.match(decision.reason, /dispatch budget/);
    }

    const ticketSpent = one({
      ...item(),
      runs: known(runs({ startedLastDay: { item: 20, all: 20 } })),
    });

    assert.equal(outcome(ticketSpent), 'waiting: nothing');
    assert.match(ticketSpent.reason, /dispatch budget/);
  });

  test('a Ticket past the budget leaves the build slot to the next', () => {
    const spent = item({ runs: known(runs({ startedLastDay: { item: 20, all: 20 } })) });

    const next = item({
      number: 12,
      ticket: known(ticket({ number: 12, ready: { ...approval, at: ago(10) } })),
    });

    assert.deepEqual(all([spent, next]).map(outcome), [
      'waiting: nothing',
      'building: start build',
    ]);
  });

  test("runs that can't be read: nothing starts", () => {
    const decision = one(item({ runs: unknown }));

    assert.equal(outcome(decision), 'waiting: nothing');
    assert.match(decision.reason, /couldn't be read/);
    assert.equal(
      outcome(one(onPr({ review: known(null) }, { runs: unknown }))),
      'reviewing: nothing',
    );
  });

  test("the Owner's @claude after the last answer starts the mention Executor, once nothing else runs", () => {
    const asked = (patch: Partial<RunsState> = {}) =>
      onPr({ mention: known(ago(5)) }, { runs: known(runs(patch)) });

    const decision = one(asked());

    assert.equal(outcome(decision), 'reviewed: start mention');
    assert.equal(decision.action.type === 'start' && decision.action.head, HEAD);
    expect(asked({ finished: [finished('mention', 2)] }), 'reviewed: nothing');
    expect(asked({ active: [active('rework')] }), 'reworking: nothing');
    // An older answer doesn't answer a newer mention.
    expect(asked({ finished: [finished('mention', 30)] }), 'reviewed: start mention');
  });
});

describe("Dependabot's pull requests", () => {
  test("only Dependabot's commits: not reviewed, the Owner's turn once CI passes", () => {
    expect(alone({ dependabotOnly: true, labels: [], review: known(null) }), 'reviewed: nothing');
  });

  test('anyone else pushed to it: reviewed like any other', () => {
    expect(alone({ labels: ['autofix'], review: known(null) }), 'reviewing: start review');
  });

  test('CI failed: the CI fixer only when it is labeled autofix', () => {
    const failing = known([passed({ conclusion: 'failure' })]);

    expect(alone({ dependabotOnly: true, labels: [], checks: failing }), 'needs-human: hand-over');
    expect(
      alone({ dependabotOnly: true, labels: ['autofix'], checks: failing }),
      'fixing: start ci-fix',
    );
  });

  test("changes asked on one the factory doesn't rework: the Owner's turn", () => {
    expect(
      alone({ labels: ['autofix'], review: known({ ...ready, verdict: 'changes' }) }),
      'reviewed: nothing',
    );
  });
});

describe('decide is pure', () => {
  test('the same states give the same decisions, and are left as they were', () => {
    const states = [item(), onPr({ review: known(null) }, { number: 7 }), alone()];
    const before = JSON.stringify(states);

    assert.deepEqual(decide(states, policy), decide(states, policy));
    assert.equal(JSON.stringify(states), before);
  });
});

describe('every state has a sentence', () => {
  test("a Work item GitHub couldn't fully answer about waits, saying what was missing", () => {
    for (const state of [item({ ticket: unknown }), item({ pullRequest: unknown })]) {
      const decision = one(state);

      assert.equal(outcome(decision), 'waiting: nothing');
      assert.match(decision.reason, /it was not gathered/);
    }
  });

  test('every state named by these cases is one of the twelve', () => {
    const named = new Set(
      all([
        // In flight beside the pull requests below, so it waits for the slot.
        item({ number: 20, ticket: known(ticket({ number: 20 })) }),
        item({ number: 21, ticket: known(building({ number: 21, building: { since: ago(10) } })) }),
        withTicket({ held: 'needs-info' }),
        onPr({ checks: known([]) }),
        onPr({ checks: known([passed({ conclusion: 'failure' })]) }),
        onPr({ review: known(null) }),
        onPr({ review: known({ ...ready, verdict: 'changes' }) }),
        onPr({ mergeable: known('CONFLICTING') }),
        onPr(),
        onPr({ status: 'merged', merged: { at: ago(10), commit: 'm1', deployed: known(false) } }),
        onPr({ status: 'merged', merged: { at: ago(10), commit: 'm1', deployed: known(true) } }),
        withTicket({ held: 'needs-human' }),
      ]).map((decision) => decision.state),
    );

    assert.deepEqual([...named].sort(), [...STATES].sort());
  });
});
