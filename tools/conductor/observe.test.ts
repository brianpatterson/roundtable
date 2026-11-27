// observe(raw, at): a Work item's state as it was at `at`. Each case is one base Work item and a
// small change to it, like test-dispatch.sh. The repository is o/r, owned by o; times are minutes
// after 10:00 on 2026-11-20.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Json } from './json.ts';
import { observe } from './observe.ts';
import type { RawWorkItem } from './raw.ts';
import type { Fact, PullRequestState, TicketState } from './state.ts';

const time = (minutes: number): string =>
  new Date(Date.UTC(2026, 10, 20, 10, minutes)).toISOString();

const at = (minutes: number): Date => new Date(time(minutes));

const labeled = (minutes: number, name: string, actor: string): Json => ({
  __typename: 'LabeledEvent',
  createdAt: time(minutes),
  label: { name },
  actor: { login: actor },
});

const unlabeled = (minutes: number, name: string, actor: string): Json => ({
  __typename: 'UnlabeledEvent',
  createdAt: time(minutes),
  label: { name },
  actor: { login: actor },
});

const renamed = (minutes: number, actor: string): Json => ({
  __typename: 'RenamedTitleEvent',
  createdAt: time(minutes),
  actor: { login: actor },
});

const closedByMerge = (minutes: number, commit: string): Json => ({
  __typename: 'ClosedEvent',
  createdAt: time(minutes),
  closer: { __typename: 'PullRequest', merged: true, mergeCommit: { oid: commit } },
});

const closedByHand = (minutes: number): Json => ({
  __typename: 'ClosedEvent',
  createdAt: time(minutes),
  closer: null,
});

const reopened = (minutes: number): Json => ({
  __typename: 'ReopenedEvent',
  createdAt: time(minutes),
});

const edit = (minutes: number, editor: string): Json => ({
  editedAt: time(minutes),
  editor: { login: editor },
});

interface TicketOptions {
  readonly timeline?: Json[];
  readonly edits?: Json[];
  readonly author?: string;
}

const ticket = (options: TicketOptions = {}): Json => ({
  number: 10,
  createdAt: time(-120),
  author: { login: options.author ?? 'o' },
  timeline: options.timeline ?? [labeled(0, 'ready', 'o')],
  edits: options.edits ?? [],
});

/** A Ticket the Owner labeled `ready` at 10:00, with nothing else. */
const base: RawWorkItem = {
  number: 10,
  owner: 'o',
  ticket: ticket(),
  blockers: [],
  pullRequest: null,
  checks: [],
  statuses: [],
  comments: [],
  deploys: [],
  inclusions: [],
  runs: [],
};

const with_ = (patch: Partial<RawWorkItem>): RawWorkItem => ({ ...base, ...patch });

function known<T>(value: Fact<T>): T {
  assert.ok(value.known, `expected a known fact, got: ${value.known ? '' : value.missing}`);

  return value.value;
}

function ticketAt(raw: RawWorkItem, minutes: number): TicketState {
  const state = known(observe(raw, at(minutes)).ticket);

  assert.ok(state !== null, 'expected a Ticket');

  return state;
}

function pullRequestAt(raw: RawWorkItem, minutes: number): PullRequestState {
  const state = known(observe(raw, at(minutes)).pullRequest);

  assert.ok(state !== null, 'expected a pull request');

  return state;
}

describe('Approval follows dispatch.sh', () => {
  test("the Owner's ready label is an Approval", () => {
    const ready = ticketAt(base, 5).ready;

    assert.equal(ready?.approved, true);
    assert.equal(ready?.voided, false);
    assert.equal(ready?.since, time(0));
  });

  test("someone else's ready label isn't", () => {
    assert.equal(
      ticketAt(with_({ ticket: ticket({ timeline: [labeled(0, 'ready', 'someone')] }) }), 5).ready
        ?.approved,
      false,
    );
  });

  test('without the ready label there is none, even before it was added', () => {
    assert.equal(ticketAt(base, -1).ready, null);
    assert.equal(
      ticketAt(
        with_({
          ticket: ticket({ timeline: [labeled(0, 'ready', 'o'), unlabeled(1, 'ready', 'o')] }),
        }),
        5,
      ).ready,
      null,
    );
  });

  test("an edit to the description by anyone but the Owner after it voids it; the Owner's doesn't", () => {
    assert.equal(
      ticketAt(with_({ ticket: ticket({ edits: [edit(10, 'stranger')] }) }), 15).ready?.voided,
      true,
    );
    assert.equal(
      ticketAt(with_({ ticket: ticket({ edits: [edit(10, 'o')] }) }), 15).ready?.voided,
      false,
    );
    assert.equal(
      ticketAt(with_({ ticket: ticket({ edits: [edit(-10, 'stranger')] }) }), 15).ready?.voided,
      false,
    );
  });

  test('a title change by anyone but the Owner after it voids it', () => {
    const raw = with_({
      ticket: ticket({ timeline: [labeled(0, 'ready', 'o'), renamed(10, 'stranger')] }),
    });

    assert.equal(ticketAt(raw, 15).ready?.voided, true);
    assert.equal(ticketAt(raw, 5).ready?.voided, false, 'an edit after `at` voids nothing at `at`');
  });

  test("the Owner removing and re-adding ready doesn't restart it; the workflow removing it does", () => {
    const relabel = (remover: string) =>
      with_({
        ticket: ticket({
          timeline: [
            labeled(-60, 'ready', 'o'),
            unlabeled(-15, 'ready', remover),
            labeled(0, 'ready', 'o'),
          ],
          edits: [edit(-30, 'stranger')],
        }),
      });

    assert.equal(ticketAt(relabel('o'), 5).ready?.voided, true);
    assert.equal(ticketAt(relabel('o'), 5).ready?.since, time(-60));
    assert.equal(ticketAt(relabel('github-actions'), 5).ready?.voided, false);
    assert.equal(ticketAt(relabel('github-actions'), 5).ready?.since, time(0));
  });

  test('a Mutation ticket the nightly run opened is approved by its own label, and marked nightly', () => {
    const mutation = (author: string, label: string, edits: Json[] = []) =>
      with_({
        ticket: ticket({
          author,
          edits,
          timeline: [labeled(0, label, 'github-actions'), labeled(0, 'ready', 'github-actions')],
        }),
      });

    assert.equal(ticketAt(mutation('github-actions', 'mutation'), 5).ready?.approved, true);
    assert.equal(ticketAt(mutation('github-actions', 'mutation'), 5).ready?.nightly, true);
    assert.equal(
      ticketAt(mutation('github-actions', 'mutation', [edit(3, 'stranger')]), 5).ready?.voided,
      true,
    );
    assert.equal(ticketAt(mutation('github-actions', 'architecture'), 5).ready?.approved, false);
    assert.equal(ticketAt(mutation('stranger', 'mutation'), 5).ready?.approved, false);
    assert.equal(ticketAt(base, 5).ready?.nightly, false);
  });

  test('needs-info holds it until the Owner labels it ready again', () => {
    const asked = [labeled(-60, 'ready', 'o'), labeled(-30, 'needs-info', 'github-actions')];
    const answered = with_({ ticket: ticket({ timeline: [...asked, labeled(0, 'ready', 'o')] }) });

    assert.equal(ticketAt(answered, -10).held, 'needs-info');
    assert.equal(ticketAt(answered, 5).held, null);
    assert.equal(ticketAt(answered, 5).answered, true);
  });

  test('needs-human holds it, and building says since when', () => {
    const raw = with_({
      ticket: ticket({
        timeline: [
          labeled(0, 'ready', 'o'),
          labeled(5, 'building', 'github-actions'),
          labeled(9, 'needs-human', 'github-actions'),
        ],
      }),
    });

    assert.equal(ticketAt(raw, 6).held, null);
    assert.deepEqual(ticketAt(raw, 6).building, { since: time(5) });
    assert.equal(ticketAt(raw, 10).held, 'needs-human');
    assert.deepEqual(ticketAt(raw, 10).labels, ['ready', 'building', 'needs-human']);
  });

  test('a Ticket opened after `at` is not there yet', () => {
    assert.equal(known(observe(base, at(-200)).ticket), null);
  });
});

describe('Blockers', () => {
  const blocker = (timeline: Json[], createdAt = time(-200)): Json => ({
    number: 3,
    createdAt,
    timeline,
  });

  const deployed = {
    deploys: [{ head_sha: 'd1', updated_at: time(20) }],
    inclusions: [{ commit: 'm1', deploy: 'd1', status: 'ahead' }],
  };

  test('a blocker merged is Deployed once a deploy that includes it has completed', () => {
    const raw = with_({ blockers: [blocker([closedByMerge(5, 'm1')])], ...deployed });
    const blockersAt = (minutes: number) => known(ticketAt(raw, minutes).blockers);

    assert.equal(blockersAt(3)[0]?.status, 'open');
    assert.equal(blockersAt(10)[0]?.status, 'merged');
    assert.deepEqual(blockersAt(10)[0]?.deployed, { known: true, value: false });
    assert.deepEqual(blockersAt(30)[0]?.deployed, { known: true, value: true });
  });

  test("a deploy that doesn't include the merge doesn't Deploy it", () => {
    const raw = with_({
      blockers: [blocker([closedByMerge(5, 'm1')])],
      ...deployed,
      inclusions: [{ commit: 'm1', deploy: 'd1', status: 'behind' }],
    });

    assert.deepEqual(known(ticketAt(raw, 30).blockers)[0]?.deployed, { known: true, value: false });
  });

  test('closed by hand, or reopened and then closed by hand, is closed unmerged', () => {
    const byHand = with_({ blockers: [blocker([closedByHand(5)])] });

    const reclosed = with_({
      blockers: [blocker([closedByMerge(5, 'm1'), reopened(6), closedByHand(7)])],
      ...deployed,
    });

    assert.equal(known(ticketAt(byHand, 10).blockers)[0]?.status, 'unmerged');
    assert.equal(known(ticketAt(reclosed, 30).blockers)[0]?.status, 'unmerged');
    assert.equal(known(ticketAt(reclosed, 6).blockers)[0]?.status, 'open');
  });

  test('held says what it waits on the Owner under, at `at`', () => {
    const raw = with_({
      blockers: [
        blocker([labeled(5, 'needs-human', 'github-actions'), unlabeled(10, 'needs-human', 'o')]),
      ],
    });

    assert.equal(known(ticketAt(raw, 7).blockers)[0]?.held, 'needs-human');
    assert.equal(known(ticketAt(raw, 12).blockers)[0]?.held, null);
  });

  test('an issue opened after `at` blocked nothing then', () => {
    assert.deepEqual(
      known(ticketAt(with_({ blockers: [blocker([], time(30))] }), 10).blockers),
      [],
    );
  });

  test("the Ticket's own merge is Deployed the same way", () => {
    const raw = with_({
      ticket: ticket({ timeline: [labeled(0, 'ready', 'o'), closedByMerge(5, 'm1')] }),
      ...deployed,
    });

    assert.equal(ticketAt(raw, 10).open, false);
    assert.deepEqual(ticketAt(raw, 30).closed, {
      merged: true,
      commit: 'm1',
      deployed: { known: true, value: true },
    });
  });
});

describe('the pull request', () => {
  const sha = (n: number) => `${n}`.repeat(40);

  const commit = (n: number, minutes: number, login: string | null): Json => ({
    commit: {
      oid: sha(n),
      committedDate: time(minutes),
      authors: { nodes: [{ user: login === null ? null : { login } }] },
    },
  });

  const comment = (minutes: number, body: string, login = 'github-actions[bot]'): Json => ({
    user: { login },
    created_at: time(minutes),
    updated_at: time(minutes),
    body,
  });

  const pullRequest = (
    timeline: Json[] = [],
    commits = [commit(1, 10, 'o'), commit(2, 20, 'claude'), commit(3, 40, null)],
  ): Json => ({
    number: 11,
    createdAt: time(10),
    author: { login: 'claude' },
    mergeable: 'CONFLICTING',
    mergeCommit: null,
    commits,
    timeline: [labeled(10, 'factory', 'github-actions'), ...timeline],
  });

  const raw = with_({
    pullRequest: pullRequest(),
    checks: [
      {
        sha: sha(2),
        checkRuns: [
          {
            name: 'check',
            status: 'completed',
            conclusion: 'success',
            started_at: time(21),
            completed_at: time(30),
          },
        ],
      },
      { sha: sha(3), checkRuns: [] },
    ],
    statuses: [{ sha: sha(2), statuses: [] }],
  });

  test('the head is the latest commit committed by `at`', () => {
    assert.deepEqual(pullRequestAt(raw, 15).head, { known: true, value: sha(1) });
    assert.deepEqual(pullRequestAt(raw, 25).head, { known: true, value: sha(2) });
    assert.equal(known(observe(raw, at(5)).pullRequest), null, 'not opened yet');
  });

  test('a check that completed after `at` was running then', () => {
    assert.deepEqual(known(pullRequestAt(raw, 25).checks), [
      { name: 'check', status: 'in_progress', conclusion: null },
    ]);
    assert.deepEqual(known(pullRequestAt(raw, 35).checks), [
      { name: 'check', status: 'completed', conclusion: 'success' },
    ]);
  });

  test("checks gather didn't read are unknown, with which commit", () => {
    const checks = pullRequestAt(raw, 15).checks;

    assert.ok(!checks.known && checks.missing.includes(sha(1)));
  });

  test('statuses are the latest of each context at `at`', () => {
    const statuses = [
      {
        context: 'factory',
        state: 'pending',
        description: 'Working: reviewing',
        created_at: time(31),
      },
      {
        context: 'factory',
        state: 'success',
        description: 'Done: ready for you',
        created_at: time(35),
      },
    ];

    const withStatuses = { ...raw, statuses: [{ sha: sha(2), statuses }] };

    assert.deepEqual(
      known(pullRequestAt(withStatuses, 33).statuses).map((status) => status.description),
      ['Working: reviewing'],
    );
    assert.deepEqual(
      known(pullRequestAt(withStatuses, 36).statuses).map((status) => status.state),
      ['success'],
    );
  });

  test('Attempts count as attempt.sh counts them: since the last human commit, or per commit of main', () => {
    const comments = [
      comment(5, '<!-- factory-ci-fix -->\n### CI fix, attempt 1 of 2: pushed a fix'),
      comment(12, '<!-- factory-ci-fix -->\n### CI fix, attempt 1 of 2: pushed a fix'),
      comment(13, '<!-- factory-ci-fix -->\n### CI fix', 'stranger'),
      comment(22, '<!-- factory-rework -->\n### Rework, attempt 1 of 2: pushed changes'),
      comment(
        23,
        '<!-- factory-rework -->\n<!-- factory-rework-minor -->\n### Rework, minor findings',
      ),
      comment(
        24,
        '<!-- factory-conflict -->\n<sub>[Run](x), merging main at aaaaaaa into commit 1. ADR-0058.</sub>',
      ),
      comment(
        25,
        '<!-- factory-conflict -->\n<sub>[Run](x), merging main at aaaaaaa into commit 2. ADR-0058.</sub>',
      ),
      comment(
        26,
        '<!-- factory-conflict -->\n<sub>[Run](x), merging main at bbbbbbb into commit 2. ADR-0058.</sub>',
      ),
    ];

    const withComments = { ...raw, comments };

    assert.deepEqual(known(pullRequestAt(withComments, 30).attempts), {
      since: time(10),
      ciFix: 1,
      rework: 1,
      minorPasses: 1,
      conflict: [
        { main: 'aaaaaaa', count: 2 },
        { main: 'bbbbbbb', count: 1 },
      ],
    });
    assert.equal(known(pullRequestAt(withComments, 22).attempts).rework, 1);
    assert.equal(
      known(pullRequestAt(withComments, 21).attempts).rework,
      0,
      'a later comment counts nothing at `at`',
    );

    // The Owner pushes: CI-fix and Rework Attempts count again from zero; conflicts don't.
    const pushed = {
      ...withComments,
      pullRequest: pullRequest(
        [],
        [commit(1, 10, 'o'), commit(2, 20, 'claude'), commit(4, 50, 'o')],
      ),
    };

    const after = known(pullRequestAt(pushed, 60).attempts);

    assert.equal(after.ciFix, 0);
    assert.equal(after.rework, 0);
    assert.equal(after.conflict.length, 2);
  });

  test('mergeability is known only at or after the latest event', () => {
    assert.deepEqual(pullRequestAt(raw, 60).mergeable, { known: true, value: 'CONFLICTING' });
    assert.equal(pullRequestAt(raw, 35).mergeable.known, false);
  });

  const review = (verdict: string, commitSha: string) =>
    comment(
      31,
      `<!-- factory-review -->\n### Factory review: ${verdict}\n<sub>Commit ${commitSha}, reviewed by the factory's reviewer agent (ADR-0026). It never approves; the owner merges.</sub>`,
    );

  test("now, the Review is the reviewer's comment", () => {
    assert.deepEqual(
      known(pullRequestAt({ ...raw, comments: [review('✅ Ready for you', sha(3))] }, 60).review),
      {
        verdict: 'ready',
        commit: sha(3),
      },
    );
    assert.deepEqual(
      known(pullRequestAt({ ...raw, comments: [review('✋ Changes needed', sha(3))] }, 60).review),
      {
        verdict: 'changes',
        commit: sha(3),
      },
    );
    assert.equal(known(pullRequestAt(raw, 60).review), null);
  });

  test('before the latest event, the Review comes from the factory status and the changes comment, or is unknown', () => {
    const edited = { ...raw, comments: [review('✅ Ready for you', sha(2))] };

    assert.equal(
      pullRequestAt(edited, 35).review.known,
      false,
      "the comment's text is today's, not then",
    );

    const status = (minutes: number, description: string) => ({
      context: 'factory',
      state: 'success',
      description,
      created_at: time(minutes),
    });

    const withStatus = {
      ...edited,
      statuses: [{ sha: sha(2), statuses: [status(32, 'Done: changes needed, your turn')] }],
    };

    assert.deepEqual(known(pullRequestAt(withStatus, 35).review), {
      verdict: 'changes',
      commit: sha(2),
    });

    const nudged = {
      ...edited,
      comments: [
        ...edited.comments,
        comment(
          33,
          `<!-- factory-review-changes -->\nRe-reviewed ${sha(2).slice(0, 7)}: ✋ changes needed. See [the factory review](x).`,
        ),
      ],
    };

    assert.deepEqual(known(pullRequestAt(nudged, 35).review), {
      verdict: 'changes',
      commit: sha(2),
    });
  });

  test('merged at `at`, and Deployed once a deploy includes the merge', () => {
    const merged = {
      ...raw,
      pullRequest: pullRequest([
        { __typename: 'MergedEvent', createdAt: time(70), commit: { oid: 'm9' } },
      ]),
      deploys: [{ head_sha: 'd9', updated_at: time(90) }],
      inclusions: [{ commit: 'm9', deploy: 'd9', status: 'identical' }],
    };

    assert.equal(pullRequestAt(merged, 60).status, 'open');
    assert.equal(pullRequestAt(merged, 80).status, 'merged');
    assert.deepEqual(pullRequestAt(merged, 80).merged?.deployed, { known: true, value: false });
    assert.deepEqual(pullRequestAt(merged, 95).merged?.deployed, { known: true, value: true });
  });

  test('its labels are those at `at`', () => {
    const relabeled = {
      ...raw,
      pullRequest: pullRequest([labeled(50, 'needs-human', 'github-actions')]),
    };

    assert.deepEqual(pullRequestAt(relabeled, 45).labels, ['factory']);
    assert.deepEqual(pullRequestAt(relabeled, 55).labels, ['factory', 'needs-human']);
  });
});

describe('Executor runs', () => {
  const run = (name: string, created: number, status: string, updated: number): Json => ({
    display_title: name,
    status,
    created_at: time(created),
    run_started_at: time(created),
    updated_at: time(updated),
  });

  const raw = with_({
    runs: [
      run('build #10 -', 0, 'completed', 30),
      run('ci-fix #10 abcdef0', 40, 'in_progress', 41),
      run('review #11 abc1234', 41, 'queued', 41),
      run('rework #10 abcdef0', -24 * 60 - 1, 'completed', -24 * 60),
      run('CI', 42, 'in_progress', 42),
    ],
  });

  const runsAt = (minutes: number) => known(observe(raw, at(minutes)).runs);

  test("those queued or running at `at` are this Work item's, by name", () => {
    assert.deepEqual(runsAt(20).active, [
      { name: 'build #10 -', kind: 'build', sha: null, status: 'in_progress' },
    ]);
    assert.deepEqual(runsAt(35).active, []);
    assert.deepEqual(runsAt(45).active, [
      { name: 'ci-fix #10 abcdef0', kind: 'ci-fix', sha: 'abcdef0', status: 'in_progress' },
    ]);
  });

  test('the runs started in the 24 hours before `at`, for this Work item and in all', () => {
    assert.deepEqual(runsAt(45).startedLastDay, { item: 2, all: 3 });
    assert.deepEqual(runsAt(-5).startedLastDay, { item: 1, all: 1 });
  });
});

describe('time', () => {
  // A Work item whose pull request has events after `at` already, so `at` is in the past.
  const sha = 'a'.repeat(40);

  const past = with_({
    blockers: [{ number: 3, createdAt: time(-200), timeline: [labeled(-100, 'ready', 'o')] }],
    pullRequest: {
      number: 11,
      createdAt: time(1),
      author: { login: 'claude' },
      mergeable: 'MERGEABLE',
      mergeCommit: null,
      commits: [{ commit: { oid: sha, committedDate: time(2), authors: { nodes: [] } } }],
      timeline: [labeled(1, 'factory', 'github-actions'), labeled(30, 'review', 'o')],
    },
    checks: [{ sha, checkRuns: [] }],
    statuses: [{ sha, statuses: [] }],
  });

  const later: RawWorkItem = {
    ...past,
    ticket: ticket({
      timeline: [
        labeled(0, 'ready', 'o'),
        unlabeled(10, 'ready', 'github-actions'),
        labeled(11, 'needs-human', 'github-actions'),
        renamed(12, 'stranger'),
        closedByMerge(13, 'm1'),
      ],
      edits: [edit(10, 'stranger')],
    }),
    blockers: [
      {
        number: 3,
        createdAt: time(-200),
        timeline: [labeled(-100, 'ready', 'o'), closedByHand(10)],
      },
    ],
    pullRequest: {
      number: 11,
      createdAt: time(1),
      author: { login: 'claude' },
      mergeable: 'CONFLICTING',
      mergeCommit: { oid: 'm1' },
      commits: [
        { commit: { oid: sha, committedDate: time(2), authors: { nodes: [] } } },
        {
          commit: {
            oid: 'b'.repeat(40),
            committedDate: time(9),
            authors: { nodes: [{ user: { login: 'o' } }] },
          },
        },
      ],
      timeline: [
        labeled(1, 'factory', 'github-actions'),
        labeled(30, 'review', 'o'),
        { __typename: 'MergedEvent', createdAt: time(13), commit: { oid: 'm1' } },
      ],
    },
    checks: [
      {
        sha,
        checkRuns: [
          {
            name: 'CI',
            status: 'completed',
            conclusion: 'failure',
            started_at: time(6),
            completed_at: time(7),
          },
        ],
      },
    ],
    statuses: [
      {
        sha,
        statuses: [
          {
            context: 'factory',
            state: 'success',
            description: 'Done: ready for you',
            created_at: time(8),
          },
        ],
      },
    ],
    comments: [
      {
        user: { login: 'github-actions[bot]' },
        created_at: time(6),
        updated_at: time(6),
        body: '<!-- factory-ci-fix -->',
      },
      {
        user: { login: 'github-actions[bot]' },
        created_at: time(7),
        updated_at: time(7),
        body: `<!-- factory-review -->\n### Factory review: ✅ Ready for you\n<sub>Commit ${sha}, reviewed</sub>`,
      },
    ],
    deploys: [{ head_sha: 'd1', updated_at: time(14) }],
    inclusions: [{ commit: 'm1', deploy: 'd1', status: 'ahead' }],
    runs: [
      {
        display_title: 'build #10 -',
        status: 'queued',
        created_at: time(8),
        run_started_at: time(8),
        updated_at: time(8),
      },
    ],
  };

  test('an event after `at` never changes the state at `at`', () => {
    assert.deepEqual(observe(later, at(5)), observe(past, at(5)));
  });
});

describe('observe never throws', () => {
  test("a field it can't read makes that part unknown, with what was missing", () => {
    const state = observe(
      with_({ ticket: { number: 10, createdAt: time(0), timeline: 'nonsense' }, runs: 5 }),
      at(5),
    );

    assert.equal(state.ticket.known, false);
    assert.ok(!state.ticket.known && state.ticket.missing.includes('ticket.timeline'));
    assert.ok(!state.runs.known && state.runs.missing.includes('runs'));
    assert.equal(state.pullRequest.known, true);
  });

  test('an invalid `at` makes everything unknown', () => {
    assert.equal(observe(base, new Date(Number.NaN)).ticket.known, false);
  });

  test('whatever replaces any one value of a Work item', () => {
    const full: Json = JSON.parse(
      JSON.stringify({
        ...base,
        ticket: ticket({
          timeline: [labeled(0, 'ready', 'o'), closedByMerge(5, 'm1')],
          edits: [edit(1, 'x')],
        }),
        blockers: [{ number: 3, createdAt: time(-1), timeline: [closedByMerge(2, 'm2')] }],
        pullRequest: {
          number: 11,
          createdAt: time(1),
          author: { login: 'a' },
          mergeable: 'MERGEABLE',
          mergeCommit: null,
          commits: [
            {
              commit: {
                oid: 'c',
                committedDate: time(2),
                authors: { nodes: [{ user: { login: 'o' } }] },
              },
            },
          ],
          timeline: [labeled(1, 'factory', 'x')],
        },
        checks: [
          {
            sha: 'c',
            checkRuns: [
              {
                name: 'CI',
                status: 'completed',
                conclusion: null,
                started_at: time(2),
                completed_at: time(3),
              },
            ],
          },
        ],
        statuses: [
          {
            sha: 'c',
            statuses: [
              { context: 'factory', state: 'success', description: null, created_at: time(3) },
            ],
          },
        ],
        comments: [
          {
            user: { login: 'github-actions[bot]' },
            created_at: time(3),
            updated_at: time(3),
            body: '<!-- factory-review -->',
          },
        ],
        deploys: [{ head_sha: 'd', updated_at: time(4) }],
        inclusions: [{ commit: 'm1', deploy: 'd', status: 'ahead' }],
        runs: [
          {
            display_title: 'build #10 -',
            status: 'queued',
            created_at: time(3),
            run_started_at: null,
            updated_at: time(3),
          },
        ],
      }),
    );

    const replacements: Json[] = [null, 'x', 7, true, [], {}, [null], { createdAt: 'never' }];
    let variants = 0;

    /** Every copy of `value` with one value somewhere inside it replaced. */
    function* variantsOf(value: Json): Generator<Json> {
      for (const replacement of replacements) yield replacement;

      if (Array.isArray(value)) {
        for (const [index, item] of value.entries()) {
          for (const variant of variantsOf(item))
            yield value.map((other, i) => (i === index ? variant : other));
        }
      } else if (value instanceof Object) {
        for (const [key, item] of Object.entries(value)) {
          if (item === undefined) continue;

          for (const variant of variantsOf(item)) yield { ...value, [key]: variant };
        }
      }
    }

    assert.ok(full instanceof Object && !Array.isArray(full));

    for (const [key, item] of Object.entries(full)) {
      if (item === undefined || key === 'number' || key === 'owner') continue;

      for (const variant of variantsOf(item)) {
        variants += 1;
        assert.doesNotThrow(() =>
          observe({ ...base, ...JSON.parse(JSON.stringify({ ...full, [key]: variant })) }, at(10)),
        );
      }
    }

    assert.ok(variants > 500, `only ${variants} variants`);
  });
});
