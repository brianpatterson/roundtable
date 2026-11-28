// plan and act: each case is one decision on one base state, and the writes it makes, against a
// stand-in fetch that records every request. The repository is o/r; the time 12:00 on 2026-11-20.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { type Surface, WORKFLOWS, type Write, act, plan, stateBody } from './act.ts';
import type { Action, Decision, StateName } from './decide.ts';
import type { GitHub } from './gather.ts';
import type { JsonObject } from './json.ts';
import { RUN_KINDS } from './run-name.ts';
import type { Fact, PullRequestState, TicketState, WorkItemState } from './state.ts';

const AT = '2026-11-20T12:00:00.000Z';

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';

const known = <T>(value: T): Fact<T> => ({ known: true, value });

const ticket = (patch: Partial<TicketState> = {}): TicketState => ({
  number: 10,
  open: true,
  closed: null,
  labels: ['ready'],
  ready: null,
  held: null,
  answered: false,
  building: null,
  blockers: known([]),
  ...patch,
});

const pullRequest = (patch: Partial<PullRequestState> = {}): PullRequestState => ({
  number: 11,
  author: 'claude',
  status: 'open',
  merged: null,
  labels: ['factory'],
  head: known(HEAD),
  headAt: known(AT),
  dependabotOnly: false,
  mention: known(null),
  mergeable: known('MERGEABLE'),
  checks: known([]),
  statuses: known([]),
  attempts: known({ since: null, ciFix: 0, rework: 0, minorPasses: 0, conflict: [] }),
  review: known(null),
  ...patch,
});

const state = (
  t: TicketState | null,
  pr: PullRequestState | null,
  active: WorkItemState['runs'] = known({
    active: [],
    finished: [],
    startedLastDay: { item: 0, all: 0 },
  }),
): WorkItemState => ({
  number: t?.number ?? pr?.number ?? 0,
  at: AT,
  ticket: known(t),
  pullRequest: known(pr),
  runs: active,
  main: known('main'),
});

const surface = (patch: Partial<Surface> = {}): Surface => ({
  target: 10,
  stateComment: null,
  said: null,
  checkRuns: [],
  runs: [],
  ...patch,
});

const decision = (number: number, name: StateName, action: Action, reason = 'Why.'): Decision => ({
  number,
  state: name,
  action,
  reason,
});

const NOTHING: Action = { type: 'nothing' };

const planned = (d: Decision, s: WorkItemState, sf: Surface = surface()): Write[] =>
  plan({ decision: d, state: s, surface: sf, repository: 'o/r', at: AT });

const requests = (writes: readonly Write[]): string[] =>
  writes.map((write) =>
    'refused' in write.request
      ? `refused: ${write.request.refused}`
      : `${write.request.method} ${write.request.path}`,
  );

const bodyOf = (write: Write | undefined): JsonObject | null | undefined =>
  write === undefined || 'refused' in write.request ? undefined : write.request.body;

/** The state comment as it already shows a decision. */
const showing = (name: StateName, reason: string): Surface['stateComment'] => ({
  id: 7,
  body: stateBody(name, reason, '2026-11-20T11:00:00.000Z'),
});

describe('starting an Executor', () => {
  test('every kind is started through its workflow in the one table, with item, kind, sha and attempt', () => {
    const cases: [Action, Record<string, string>][] = [
      [
        { type: 'start', executor: 'ci-fix', item: 11, head: HEAD, attempt: 2, minor: false },
        { item: '11', kind: 'ci-fix', sha: HEAD, attempt: '2' },
      ],
      [
        { type: 'start', executor: 'review', item: 11, head: HEAD, attempt: null, minor: false },
        { item: '11', kind: 'review', sha: HEAD, attempt: '' },
      ],
      [
        { type: 'start', executor: 'rework', item: 11, head: HEAD, attempt: null, minor: true },
        { item: '11', kind: 'rework', sha: HEAD, attempt: 'minor' },
      ],
    ];

    for (const [action, inputs] of cases) {
      assert.ok(action.type === 'start');

      const writes = planned(
        decision(11, 'reviewing', action),
        state(null, pullRequest({ statuses: known([]) })),
        surface({ target: 11, stateComment: showing('reviewing', 'Why.') }),
      );

      const dispatch = writes.find((write) => write.what.startsWith('start'));

      assert.equal(
        dispatch !== undefined && !('refused' in dispatch.request) && dispatch.request.path,
        `/repos/o/r/actions/workflows/${WORKFLOWS[action.executor]}/dispatches`,
      );
      assert.deepEqual(bodyOf(dispatch), { ref: 'main', inputs });
    }
  });

  test('the table names a workflow for every kind, and the README lists it, since the wiring must match', () => {
    const readme = readFileSync(new URL('README.md', import.meta.url), 'utf8');

    for (const kind of RUN_KINDS) {
      assert.match(WORKFLOWS[kind], /^[a-z-]+\.yml$/);

      // A table row, however Prettier pads it: | `build`    | `factory.yml`   |
      const row = new RegExp(
        `\\| \`${kind}\` +\\| \`${WORKFLOWS[kind].replace('.', '\\.')}\` +\\|`,
      );

      assert.match(readme, row, `README.md doesn't list ${kind}`);
    }
  });

  test('a build of an answered Ticket takes `needs-info` off, as dispatch.sh does', () => {
    const writes = planned(
      decision(10, 'building', {
        type: 'start',
        executor: 'build',
        item: 10,
        head: null,
        attempt: 1,
        minor: false,
      }),
      state(ticket({ labels: ['needs-info', 'ready'], answered: true }), null),
    );

    assert.deepEqual(requests(writes), [
      'POST /repos/o/r/issues/10/labels',
      'DELETE /repos/o/r/issues/10/labels/needs-info',
      'POST /repos/o/r/actions/workflows/factory.yml/dispatches',
      'POST /repos/o/r/issues/10/comments',
    ]);
  });
});

describe('a Hand-over and a withdrawn Approval', () => {
  const handOver: Action = { type: 'hand-over', reason: 'It is yours.' };

  test('a pull request with no Ticket is labeled `needs-human` itself, with the reason', () => {
    const writes = planned(
      decision(11, 'needs-human', handOver, 'It is yours.'),
      state(null, pullRequest()),
      surface({ target: 11 }),
    );

    assert.deepEqual(writes.map((write) => write.what).slice(0, 2), [
      'label #11 needs-human',
      'comment on #11: It is yours.',
    ]);
    assert.deepEqual(bodyOf(writes[1]), { body: '<!-- factory-conductor -->\nIt is yours.' });
  });

  test('the same reason is not posted twice in a row', () => {
    const writes = planned(
      decision(10, 'needs-human', handOver, 'It is yours.'),
      state(ticket({ labels: ['ready', 'building'] }), null),
      surface({ said: '<!-- factory-conductor -->\nIt is yours.' }),
    );

    assert.deepEqual(
      writes.map((write) => write.what),
      [
        'label #10 needs-human',
        'unlabel #10 building',
        'post the state comment on #10: needs-human',
      ],
    );
  });

  test("a withdrawn Approval takes the Owner's `ready` off and says why", () => {
    const reason = 'Edited after you labeled it.';

    const writes = planned(
      decision(10, 'waiting', { type: 'withdraw', reason }, reason),
      state(ticket(), null),
      surface({ stateComment: showing('waiting', reason) }),
    );

    assert.deepEqual(requests(writes), [
      'DELETE /repos/o/r/issues/10/labels/ready',
      'POST /repos/o/r/issues/10/comments',
    ]);
    assert.deepEqual(bodyOf(writes[1]), { body: `<!-- factory-conductor -->\n${reason}` });
  });

  test('once handed over, the state comment keeps the reason it was handed over for', () => {
    const writes = planned(
      decision(10, 'needs-human', NOTHING, 'It is labeled `needs-human`, so it waits for you.'),
      state(ticket({ labels: ['ready', 'needs-human'], held: 'needs-human' }), null),
      surface({ stateComment: showing('needs-human', 'It is yours.') }),
    );

    assert.deepEqual(writes, []);
  });
});

describe('the state comment', () => {
  const d = decision(10, 'waiting', NOTHING, 'It is blocked by #3.');
  const s = state(ticket(), null);

  test('posted the first time, with the state, the reason and the time', () => {
    const writes = planned(d, s);

    assert.deepEqual(requests(writes), ['POST /repos/o/r/issues/10/comments']);
    assert.deepEqual(bodyOf(writes[0]), {
      body: `<!-- factory-state -->\n**State:** \`waiting\`\nIt is blocked by #3.\n\n<sub>Since ${AT}: the factory's Conductor, ADR-0075.</sub>`,
    });
  });

  test('left alone while the state and reason are the same', () => {
    assert.deepEqual(
      planned(d, s, surface({ stateComment: showing('waiting', 'It is blocked by #3.') })),
      [],
    );
  });

  test('edited when the reason changes, or the state', () => {
    for (const comment of [
      showing('waiting', 'It is blocked by #4.'),
      showing('building', 'It is blocked by #3.'),
    ]) {
      assert.deepEqual(requests(planned(d, s, surface({ stateComment: comment }))), [
        'PATCH /repos/o/r/issues/comments/7',
      ]);
    }
  });
});

describe('the factory status', () => {
  const status = (writes: readonly Write[]): JsonObject | null | undefined =>
    bodyOf(writes.find((write) => write.what.startsWith('set the factory status')));

  const comment = (name: StateName): Surface => surface({ stateComment: showing(name, 'Why.') });

  test("success when it's the Owner's turn: reviewed, with ADR-0063's words, or needs-human", () => {
    const review = { verdict: 'ready', commit: HEAD, at: AT, minor: 2 } as const;
    const reviewed = state(ticket(), pullRequest({ review: known(review) }));

    assert.deepEqual(
      status(planned(decision(10, 'reviewed', NOTHING), reviewed, comment('reviewed'))),
      {
        context: 'factory',
        state: 'success',
        description: 'Done: ready for you, with minor findings',
        target_url: null,
      },
    );

    const held = state(ticket({ labels: ['ready', 'needs-human'] }), pullRequest());

    assert.deepEqual(
      status(planned(decision(10, 'needs-human', NOTHING), held, comment('needs-human'))),
      {
        context: 'factory',
        state: 'success',
        description: 'Done: needs-human, your turn',
        target_url: null,
      },
    );
  });

  test("error when this head's Executor run that finished last stopped, linking it", () => {
    const stopped = surface({
      stateComment: showing('fixing', 'Why.'),
      runs: [
        { name: `ci-fix #10 ${HEAD.slice(0, 7)}`, id: 1, conclusion: 'success', createdAt: 1 },
        { name: `ci-fix #10 ${HEAD.slice(0, 7)}`, id: 2, conclusion: 'failure', createdAt: 2 },
        // Another head's: not this one's.
        { name: 'review #10 1234567', id: 3, conclusion: 'success', createdAt: 3 },
      ],
    });

    assert.deepEqual(
      status(planned(decision(10, 'fixing', NOTHING), state(ticket(), pullRequest()), stopped)),
      {
        context: 'factory',
        state: 'error',
        description: `Stopped: ci-fix #10 ${HEAD.slice(0, 7)} ended failure`,
        target_url: 'https://github.com/o/r/actions/runs/2',
      },
    );
  });

  test('pending while the factory works on it; nothing written when the head already shows it', () => {
    const pending = {
      context: 'factory',
      state: 'pending',
      description: 'Working: checking',
      at: AT,
    } as const;

    assert.deepEqual(
      status(
        planned(
          decision(10, 'checking', NOTHING),
          state(ticket(), pullRequest()),
          comment('checking'),
        ),
      ),
      { context: 'factory', state: 'pending', description: 'Working: checking', target_url: null },
    );
    assert.deepEqual(
      planned(
        decision(10, 'checking', NOTHING),
        state(
          ticket({ labels: ['ready', 'building'] }),
          pullRequest({ statuses: known([pending]) }),
        ),
        comment('checking'),
      ),
      [],
    );
  });
});

describe('a rerun', () => {
  test("a check no Actions run made can't be rerun, and says so", () => {
    const writes = planned(
      decision(11, 'checking', { type: 'rerun', head: HEAD, checks: ['external'] }),
      state(null, pullRequest()),
      surface({ target: 11, checkRuns: [{ name: 'external', startedAt: 1, run: null }] }),
    );

    assert.equal(
      requests(writes)[0],
      'refused: no Actions run made it, so there is nothing to rerun',
    );
  });
});

describe('act', () => {
  /** A stand-in GitHub that records each request it's sent, and fails those to `/fail`. */
  interface Recording {
    readonly github: GitHub;
    readonly sent: string[];
  }

  const recording = (): Recording => {
    const sent: string[] = [];

    return {
      sent,
      github: {
        token: 'token',
        repository: 'o/r',
        fetch: async (input, init) => {
          sent.push(`${init?.method ?? 'GET'} ${String(input)}`);

          return new Response(null, { status: String(input).includes('/fail') ? 500 : 204 });
        },
      },
    };
  };

  const write = (path: string): Write => ({
    item: 10,
    what: `write ${path}`,
    request: { method: 'POST', path, body: null },
    undo: null,
  });

  test('a dry run prints each write and sends nothing', async () => {
    const { github, sent } = recording();
    const out: string[] = [];

    const failed = await act(github, [write('/a'), write('/b')], {
      dryRun: true,
      out: (line) => out.push(line),
    });

    assert.deepEqual(sent, []);
    assert.deepEqual(failed, []);
    assert.deepEqual(out, ['#10: write /a', '#10: write /b']);
  });

  test('a failed write is named, the rest are made, and a refused one is never sent', async () => {
    const { github, sent } = recording();

    const refused: Write = {
      item: 11,
      what: 'rerun x',
      request: { refused: 'no run' },
      undo: null,
    };

    const failed = await act(github, [write('/fail'), refused, write('/b')], {
      dryRun: false,
      out: () => undefined,
    });

    assert.deepEqual(sent, ['POST https://api.github.com/fail', 'POST https://api.github.com/b']);
    assert.deepEqual(failed, ['#10: write /fail: GitHub answered 500', '#11: rerun x: no run']);
  });
});
