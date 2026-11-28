// decide(states, policy): every open Work item's state named, its next step, and the reason in one
// sentence (ADR-0075, ADR-0076). Pure: the time is each state's `at`, and every number is the
// policy's. It decides; `act` writes.

import type { Policy } from './policy.ts';
import type { RunKind } from './run-name.ts';
import type {
  CheckState,
  Fact,
  FinishedRun,
  PullRequestState,
  Ready,
  RunsState,
  TicketState,
  WorkItemState,
} from './state.ts';

/** The states a Work item can be in (README.md, ADR-0075 as amended by ADR-0076). */
export const STATES = [
  'waiting',
  'building',
  'needs-info',
  'checking',
  'fixing',
  'reviewing',
  'reworking',
  'resolving',
  'reviewed',
  'merged',
  'deployed',
  'needs-human',
] as const;

export type StateName = (typeof STATES)[number];

/** What `act` does for a Work item. */
export type Action =
  | { readonly type: 'nothing' }
  | {
      readonly type: 'start';
      readonly executor: RunKind;
      /** The Work item's number: the Ticket's, or the pull request's when there's no Ticket. */
      readonly item: number;
      /** The head it's started for; `null` before there's a pull request. */
      readonly head: string | null;
      /** Which Attempt of its kind this is; `null` for a run that isn't one (a review, a mention, the Minor pass). */
      readonly attempt: number | null;
      /** Rework's Minor pass (ADR-0053). */
      readonly minor: boolean;
    }
  /** Label it `needs-human` (and take `building` off a Ticket), saying why. */
  | { readonly type: 'hand-over'; readonly reason: string }
  /** Take the Owner's `ready` off a Ticket, saying why. */
  | { readonly type: 'withdraw'; readonly reason: string }
  /** Rerun the checks on the head that ended neither passing nor failing. */
  | { readonly type: 'rerun'; readonly head: string; readonly checks: readonly string[] };

export interface Decision {
  readonly number: number;
  readonly state: StateName;
  readonly action: Action;
  /** One plain sentence: what it waits for, and what the Owner can do when it waits on them. */
  readonly reason: string;
  /**
   * Set when it waits on the Owner without being handed over: a pull request the factory doesn't
   * look after (`UNSWEPT`), so its `factory` status says it's their turn (ADR-0063).
   */
  readonly ownersTurn?: true;
}

/** The state an Executor's run puts its Work item in while it's queued or running. */
const RUNNING: Readonly<Record<Exclude<RunKind, 'mention'>, StateName>> = {
  build: 'building',
  'ci-fix': 'fixing',
  review: 'reviewing',
  rework: 'reworking',
  conflict: 'resolving',
};

/** The states in which a Ticket holds the one build slot (ADR-0047): from its build until it's Deployed. */
const IN_FLIGHT: readonly StateName[] = [
  'building',
  'checking',
  'fixing',
  'reviewing',
  'reworking',
  'resolving',
  'reviewed',
  'merged',
];

const NOTHING: Action = { type: 'nothing' };

/** Check conclusions that count as passing. */
const PASSING = ['success', 'skipped', 'neutral'];

const short = (sha: string): string => sha.slice(0, 7);

/** Whether two names for a commit, full or abbreviated, are the same commit. */
const sameCommit = (a: string, b: string): boolean =>
  a !== '' && b !== '' && (a.startsWith(b) || b.startsWith(a));

const minutesBetween = (from: string, to: string): number =>
  Math.floor((Date.parse(to) - Date.parse(from)) / 60_000);

const refs = (numbers: readonly number[]): string => numbers.map((n) => `#${n}`).join(', ');

const latest = (times: readonly string[]): string =>
  times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));

const earliest = (times: readonly string[]): string =>
  times.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));

const decision = (number: number, state: StateName, action: Action, reason: string): Decision => ({
  number,
  state,
  action,
  reason,
});

const wait = (number: number, state: StateName, reason: string): Decision =>
  decision(number, state, NOTHING, reason);

/** A wait on the Owner for a pull request the factory doesn't look after (`UNSWEPT`). */
const yours = (number: number, state: StateName, reason: string): Decision => ({
  ...wait(number, state, reason),
  ownersTurn: true,
});

const handOver = (number: number, reason: string): Decision =>
  decision(number, 'needs-human', { type: 'hand-over', reason }, reason);

interface Start {
  readonly executor: RunKind;
  readonly head: string | null;
  readonly attempt: number | null;
  readonly minor?: boolean;
}

const start = (number: number, state: StateName, run: Start, reason: string): Decision =>
  decision(
    number,
    state,
    {
      type: 'start',
      executor: run.executor,
      item: number,
      head: run.head,
      attempt: run.attempt,
      minor: run.minor ?? false,
    },
    reason,
  );

/** One Work item's decision, and whether it waits only for the build slot. */
interface Pending {
  readonly decision: Decision;
  /** Set when it would start its first build if no other Ticket held the slot. */
  readonly wantsSlot: Ready | null;
}

const settled = (decision: Decision): Pending => ({ decision, wantsSlot: null });

/** What one Work item sees of the rest, and of the time. */
interface Context {
  readonly state: WorkItemState;
  readonly policy: Policy;
  readonly runs: RunsState | null;
}

/** This Work item's finished runs of `kind` for `head`, created at or after `since`. */
function taken(context: Context, kind: RunKind, head: string | null, since: string): FinishedRun[] {
  return (context.runs?.finished ?? []).filter(
    (run) =>
      run.kind === kind &&
      (head === null || (run.sha !== null && sameCommit(head, run.sha))) &&
      Date.parse(run.createdAt) >= Date.parse(since),
  );
}

/** Whether `needs-human` is on the Ticket or the pull request. */
const handedOver = (ticket: TicketState | null, pr: PullRequestState | null): boolean =>
  ticket?.held === 'needs-human' || (pr?.labels.includes('needs-human') ?? false);

/**
 * A pull request labeled neither `factory` nor `autofix` (Dependabot's own) is the Owner's, as the
 * sweeper leaves it (ADR-0040): the factory reviews it, but neither hands it over nor reruns it.
 */
const UNSWEPT =
  'and the factory looks after only pull requests labeled `factory` or `autofix`, so it is yours';

const HELD =
  'It is labeled `needs-human`, so it waits for you: settle what it needs, then remove the label to hand it back to the factory.';

function merged(
  context: Context,
  held: boolean,
  merge: { readonly commit: string; readonly at: string; readonly deployed: Fact<boolean> },
): Decision {
  const { number, at } = context.state;

  if (merge.deployed.known && merge.deployed.value)
    return wait(
      number,
      'deployed',
      `Its merge ${short(merge.commit)} is Deployed, so nothing is left to do.`,
    );

  if (held) return wait(number, 'needs-human', HELD);

  if (!merge.deployed.known) {
    return wait(
      number,
      'merged',
      `It merged as ${short(merge.commit)}, and whether a deploy includes it couldn't be read (${merge.deployed.missing}), so the factory waits to read it again.`,
    );
  }

  const minutes = minutesBetween(merge.at, at);

  if (minutes >= context.policy.undeployedMinutes) {
    return handOver(
      number,
      `Its merge ${short(merge.commit)} is not Deployed ${minutes} minutes after it merged, so it is yours: find why the Deploy workflow hasn't shipped it, then remove \`needs-human\`.`,
    );
  }

  return wait(
    number,
    'merged',
    `It merged as ${short(merge.commit)} and waits for a deploy to include it.`,
  );
}

/** A Ticket before its pull request. */
function beforePullRequest(context: Context, ticket: TicketState): Pending {
  const { number, at } = context.state;
  const { policy } = context;

  if (ticket.held === 'needs-human') return settled(wait(number, 'needs-human', HELD));

  if (ticket.held === 'needs-info') {
    return settled(
      wait(
        number,
        'needs-info',
        'It waits for your answers (`needs-info`): answer the questions on it, then label it `ready` again.',
      ),
    );
  }

  const ready = ticket.ready;

  if (ready !== null && ready.approved && ready.voided) {
    const reason =
      'Its title or description was edited by someone else after you labeled it `ready`, so the factory takes the label off: reread it, and label it `ready` again if it should still be built.';

    return settled(decision(number, 'waiting', { type: 'withdraw', reason }, reason));
  }

  if (ticket.building !== null) {
    // Builds count while it's `building`: `act` takes the label off when it hands a Ticket over, so
    // one the Owner hands back starts counting again.
    const failed = taken(context, 'build', null, ticket.building.since).length;

    if (failed >= policy.builds) {
      return settled(
        handOver(
          number,
          `Its build ended without a pull request ${failed} times, so it is yours: read the build runs, settle what stopped them, then remove \`needs-human\` to have it built again.`,
        ),
      );
    }

    if (ready === null || !ready.approved) {
      return settled(
        wait(
          number,
          'waiting',
          'It is `building` but no longer labeled `ready` by you, so the factory starts nothing more for it: label it `ready` again to have it built.',
        ),
      );
    }

    if (failed > 0) {
      return settled(
        start(
          number,
          'building',
          { executor: 'build', head: null, attempt: failed + 1 },
          `Its build ended without a pull request, so the factory builds it again (attempt ${failed + 1} of ${policy.builds}).`,
        ),
      );
    }

    const minutes = minutesBetween(ticket.building.since, at);

    if (minutes > policy.staleBuildMinutes) {
      return settled(
        handOver(
          number,
          `The factory started building it ${minutes} minutes ago and no build run or pull request has appeared, so it is yours: check the build, then remove \`needs-human\` to have it built again.`,
        ),
      );
    }

    return settled(
      wait(number, 'building', 'The factory started building it and waits for the build run.'),
    );
  }

  if (ready === null || !ready.approved) {
    return settled(
      wait(
        number,
        'waiting',
        "It isn't approved: label it `ready` yourself to have the factory build it.",
      ),
    );
  }

  if (!ticket.blockers.known) {
    return settled(
      wait(
        number,
        'waiting',
        `Its Blockers couldn't be read (${ticket.blockers.missing}), so the factory waits to read them again.`,
      ),
    );
  }

  const blockers = ticket.blockers.value;
  const unmerged = blockers.filter((blocker) => blocker.status === 'unmerged');

  if (unmerged.length > 0) {
    return settled(
      handOver(
        number,
        `${refs(unmerged.map((blocker) => blocker.number))} closed without a merged pull request, so the plan may have changed and it is yours: remove that dependency if this should still be built, then remove \`needs-human\`.`,
      ),
    );
  }

  const waitingOn = blockers.filter(
    (blocker) => blocker.status === 'open' || !blocker.deployed.known || !blocker.deployed.value,
  );

  if (waitingOn.length > 0) {
    const held = waitingOn.filter((blocker) => blocker.status === 'open' && blocker.held !== null);

    const idle = waitingOn.filter(
      (blocker) =>
        blocker.status === 'open' &&
        blocker.held === null &&
        !blocker.labels.some((label) => label === 'ready' || label === 'building'),
    );

    const parts = [
      `It is blocked by ${refs(waitingOn.map((blocker) => blocker.number))}, until each is merged and Deployed`,
      ...(held.length === 0
        ? []
        : [
            `${held.map((blocker) => `#${blocker.number} (\`${blocker.held ?? ''}\`)`).join(', ')} waits on you, so settle each first`,
          ]),
      ...(idle.length === 0
        ? []
        : [
            `nothing will finish ${refs(idle.map((blocker) => blocker.number))}, which has no \`ready\` or \`building\` label, so label each \`ready\` or, if its work is already merged, remove the dependency and close the issue`,
          ]),
    ];

    return settled(wait(number, 'waiting', `${parts.join('; ')}.`));
  }

  return {
    decision: start(
      number,
      'building',
      { executor: 'build', head: null, attempt: 1 },
      'Nothing blocks it, so the factory starts building it.',
    ),
    wantsSlot: ready,
  };
}

/** An open pull request: its CI, its Review, its conflicts. */
function onPullRequest(
  context: Context,
  ticket: TicketState | null,
  pr: PullRequestState,
): Decision {
  const { number } = context.state;
  const { policy } = context;

  if (handedOver(ticket, pr)) return wait(number, 'needs-human', HELD);

  if (!pr.head.known || !pr.headAt.known) {
    return wait(
      number,
      'checking',
      `Its head couldn't be read (${pr.head.known ? 'its time' : pr.head.missing}), so the factory waits to read it again.`,
    );
  }

  const head = pr.head.value;
  const sha = short(head);
  const factory = pr.labels.includes('factory');
  const fixable = factory || pr.labels.includes('autofix');
  const attempts = pr.attempts;

  if (pr.mergeable.known && pr.mergeable.value === 'CONFLICTING') {
    if (!fixable) {
      return yours(
        number,
        'checking',
        `It conflicts with main, ${UNSWEPT}: merge main into the branch and resolve it.`,
      );
    }

    if (!factory) {
      return handOver(
        number,
        'It conflicts with main, and the factory resolves conflicts only on its own pull requests, so it is yours: merge main into the branch and resolve it, then remove `needs-human`.',
      );
    }

    if (!attempts.known) {
      return wait(
        number,
        'resolving',
        `It conflicts with main, and its Attempts couldn't be read (${attempts.missing}), so the factory waits to read them again.`,
      );
    }

    const main = context.state.main;

    // Attempts count per commit of main; when main can't be read, the most made for any.
    const tried = main.known
      ? attempts.value.conflict
          .filter((entry) => sameCommit(entry.main, main.value))
          .reduce((sum, entry) => sum + entry.count, 0)
      : Math.max(0, ...attempts.value.conflict.map((entry) => entry.count));

    const against = main.known ? `main at ${short(main.value)}` : 'main';

    if (tried >= policy.attempts.conflict) {
      return handOver(
        number,
        `The factory tried ${tried} times to resolve its conflict with ${against} and it still conflicts, so it is yours: merge main into the branch and resolve it, then remove \`needs-human\`.`,
      );
    }

    return start(
      number,
      'resolving',
      { executor: 'conflict', head, attempt: tried + 1 },
      `It conflicts with ${against}, so the factory starts the conflict resolver (attempt ${tried + 1} of ${policy.attempts.conflict}).`,
    );
  }

  if (pr.mergeable.known && pr.mergeable.value === 'UNKNOWN') {
    return wait(
      number,
      'checking',
      'GitHub is still working out whether it conflicts with main, so the factory waits for it.',
    );
  }

  if (!pr.checks.known) {
    return wait(
      number,
      'checking',
      `Its checks couldn't be read (${pr.checks.missing}), so the factory waits to read them again.`,
    );
  }

  return checks(context, pr, { head, sha, factory, fixable, checks: pr.checks.value });
}

interface Head {
  readonly head: string;
  readonly sha: string;
  readonly factory: boolean;
  readonly fixable: boolean;
  readonly checks: readonly CheckState[];
}

function checks(
  context: Context,
  pr: PullRequestState,
  { head, sha, factory, fixable, checks: list }: Head,
): Decision {
  const { number, at } = context.state;
  const { policy } = context;
  const attempts = pr.attempts;

  if (list.length === 0) {
    const minutes = pr.headAt.known ? minutesBetween(pr.headAt.value, at) : 0;

    if (minutes > policy.stale.ciStart) {
      if (!fixable) {
        return yours(
          number,
          'checking',
          `No CI run has started on its head ${sha} in ${minutes} minutes, ${UNSWEPT}: push again or start CI.`,
        );
      }

      return handOver(
        number,
        `No CI run has started on its head ${sha} in ${minutes} minutes, so it is yours: push again or start CI, then remove \`needs-human\`.`,
      );
    }

    return wait(number, 'checking', `It waits for CI to start on ${sha}.`);
  }

  const running = list.filter((check) => check.status !== 'completed');

  if (running.length > 0) {
    const minutes = minutesBetween(earliest(running.map((check) => check.startedAt)), at);

    if (minutes > policy.stale.ciRun) {
      if (!fixable) {
        return yours(
          number,
          'checking',
          `CI has been running on ${sha} for ${minutes} minutes, ${UNSWEPT}: cancel or rerun it.`,
        );
      }

      return handOver(
        number,
        `CI has been running on ${sha} for ${minutes} minutes, so it is yours: cancel or rerun it, then remove \`needs-human\`.`,
      );
    }

    return wait(number, 'checking', `CI is running on ${sha}.`);
  }

  const failed = list.filter((check) => check.conclusion === 'failure');

  if (failed.length > 0) {
    if (!fixable) {
      return yours(
        number,
        'checking',
        `CI failed on ${sha}, ${UNSWEPT}: push a fix, or label it \`autofix\` to have the factory fix it.`,
      );
    }

    if (!attempts.known) {
      return wait(
        number,
        'fixing',
        `CI failed on ${sha}, and its Attempts couldn't be read (${attempts.missing}), so the factory waits to read them again.`,
      );
    }

    const tried = attempts.value.ciFix;

    if (tried >= policy.attempts.ciFix) {
      return handOver(
        number,
        `The factory tried ${tried} times to fix CI and it still fails on ${sha}, so it is yours: push a fix yourself, which resets the count, and remove \`needs-human\`.`,
      );
    }

    const failedAt = latest(failed.map((check) => check.completedAt ?? check.startedAt));

    if (taken(context, 'ci-fix', head, failedAt).length > 0) {
      const minutes = minutesBetween(failedAt, at);

      if (minutes > policy.stale.ciFix) {
        return handOver(
          number,
          `The CI fixer ran on ${sha} and CI still fails ${minutes} minutes later with nothing new pushed, so it is yours: push a fix, then remove \`needs-human\`.`,
        );
      }

      return wait(
        number,
        'fixing',
        `The CI fixer has run on ${sha}, and the factory waits for what it pushed or reran.`,
      );
    }

    return start(
      number,
      'fixing',
      { executor: 'ci-fix', head, attempt: tried + 1 },
      `CI failed on ${sha}, so the factory starts the CI fixer (attempt ${tried + 1} of ${policy.attempts.ciFix}).`,
    );
  }

  const ended = list.filter((check) => !PASSING.includes(check.conclusion ?? ''));

  if (ended.length > 0) {
    const how = [
      ...new Set(ended.map((check) => `\`${check.conclusion ?? 'no conclusion'}\``)),
    ].join(', ');

    if (!fixable) {
      return yours(number, 'checking', `CI ended ${how} on ${sha}, ${UNSWEPT}: rerun it.`);
    }

    if (ended.some((check) => check.runs > policy.reruns)) {
      return handOver(
        number,
        `CI ended ${how} on ${sha} again after a rerun, so it is yours: find why, then remove \`needs-human\`.`,
      );
    }

    const reason = `CI ended ${how} on ${sha}, which a job timing out also does, so the factory reruns it once.`;

    return decision(
      number,
      'checking',
      { type: 'rerun', head, checks: ended.map((check) => check.name) },
      reason,
    );
  }

  return review(context, pr, { head, sha, factory, fixable, checks: list });
}

function review(
  context: Context,
  pr: PullRequestState,
  { head, sha, factory, fixable, checks: list }: Head,
): Decision {
  const { number, at } = context.state;
  const { policy } = context;
  const attempts = pr.attempts;

  if (pr.dependabotOnly) {
    return wait(
      number,
      'reviewed',
      `CI passed on ${sha}, and the reviewer skips a pull request with only Dependabot's commits, so it is your turn to merge it.`,
    );
  }

  if (!pr.review.known) {
    return wait(
      number,
      'reviewing',
      `Its Review couldn't be read (${pr.review.missing}), so the factory waits to read it again.`,
    );
  }

  const current =
    pr.review.value !== null && sameCommit(pr.review.value.commit, head) ? pr.review.value : null;

  if (current === null) {
    const passedAt = latest(list.map((check) => check.completedAt ?? check.startedAt));

    if (taken(context, 'review', head, passedAt).length > 0) {
      const minutes = minutesBetween(passedAt, at);

      if (minutes > policy.stale.review) {
        if (!fixable) {
          return yours(
            number,
            'reviewing',
            `The reviewer ran on ${sha} and left no Review ${minutes} minutes after CI passed, ${UNSWEPT}: review it or rerun the reviewer.`,
          );
        }

        return handOver(
          number,
          `The reviewer ran on ${sha} and left no Review ${minutes} minutes after CI passed, so it is yours: review it or rerun the reviewer, then remove \`needs-human\`.`,
        );
      }

      return wait(
        number,
        'reviewing',
        `The reviewer has run on ${sha}, and the factory waits for its Review.`,
      );
    }

    return start(
      number,
      'reviewing',
      { executor: 'review', head, attempt: null },
      `CI passed on ${sha}, so the factory starts the reviewer.`,
    );
  }

  if (current.verdict === 'ready') {
    const minor = current.minor ?? 0;

    if (
      factory &&
      minor > 0 &&
      attempts.known &&
      attempts.value.minorPasses < policy.minorPasses &&
      taken(context, 'rework', head, current.at).length === 0
    ) {
      return start(
        number,
        'reworking',
        { executor: 'rework', head, attempt: null, minor: true },
        `The Review of ${sha} is ready with ${minor} minor findings, so the factory starts Rework's one Minor pass on them.`,
      );
    }

    return wait(
      number,
      'reviewed',
      minor > 0
        ? `The Review of ${sha} is ready and its minor findings are yours, so it is your turn to merge it.`
        : `The Review of ${sha} is ready, so it is your turn to merge it.`,
    );
  }

  if (!factory) {
    return wait(
      number,
      'reviewed',
      `The reviewer asked for changes on ${sha}, and the factory reworks only its own pull requests, so it is your turn to push them or merge it.`,
    );
  }

  if (!attempts.known) {
    return wait(
      number,
      'reworking',
      `The reviewer asked for changes on ${sha}, and its Attempts couldn't be read (${attempts.missing}), so the factory waits to read them again.`,
    );
  }

  const tried = attempts.value.rework;

  if (tried >= policy.attempts.rework) {
    return handOver(
      number,
      `The factory reworked it ${tried} times and the reviewer still asks for changes on ${sha}, so it is yours: push a fix yourself, which resets the count, and remove \`needs-human\`.`,
    );
  }

  if (taken(context, 'rework', head, current.at).length > 0) {
    const minutes = minutesBetween(current.at, at);

    if (minutes > policy.stale.rework) {
      return handOver(
        number,
        `Rework ran on ${sha} and nothing new was pushed ${minutes} minutes after the reviewer asked for changes, so it is yours: push a fix, then remove \`needs-human\`.`,
      );
    }

    return wait(
      number,
      'reworking',
      `Rework has run on ${sha}, and the factory waits for what it pushed.`,
    );
  }

  return start(
    number,
    'reworking',
    { executor: 'rework', head, attempt: tried + 1 },
    `The reviewer asked for changes on ${sha}, so the factory starts Rework (attempt ${tried + 1} of ${policy.attempts.rework}).`,
  );
}

/** One Work item on its own: everything but the build slot. */
function decideItem(state: WorkItemState, policy: Policy): Pending {
  const { number } = state;
  const runs = state.runs.known ? state.runs.value : null;
  const context: Context = { state, policy, runs };

  if (!state.ticket.known) {
    return settled(
      wait(
        number,
        'waiting',
        `Its Ticket couldn't be read (${state.ticket.missing}), so the factory waits to read it again.`,
      ),
    );
  }

  if (!state.pullRequest.known) {
    return settled(
      wait(
        number,
        'waiting',
        `Its pull request couldn't be read (${state.pullRequest.missing}), so the factory waits to read it again.`,
      ),
    );
  }

  const ticket = state.ticket.value;
  const pr = state.pullRequest.value;
  const pending = core(context, ticket, pr);

  // Nothing more starts while an Executor is queued or running for it, and the state names it.
  const active = runs?.active ?? [];
  const running = active.find((run) => run.kind !== 'mention') ?? active[0];

  if (running !== undefined) {
    const doing = running.status === 'queued' ? 'queued' : 'running';

    if (running.kind === 'mention') {
      return settled(
        wait(
          number,
          pending.decision.state,
          `Its mention Executor (${running.name}) is ${doing} to answer your \`@claude\`, so the factory waits for it to finish.`,
        ),
      );
    }

    return settled(
      wait(
        number,
        RUNNING[running.kind],
        `Its ${running.kind} Executor (${running.name}) is ${doing}, so the factory waits for it to finish.`,
      ),
    );
  }

  // The Owner's `@claude` on the pull request after the last answer: their ask comes first, unless
  // it's handed over, which every Executor's guard refuses (ADR-0075).
  if (
    !handedOver(ticket, pr) &&
    pr !== null &&
    pr.status === 'open' &&
    pr.head.known &&
    pr.mention.known &&
    pr.mention.value !== null
  ) {
    const answered = taken(context, 'mention', null, pr.mention.value).length > 0;

    if (!answered) {
      return settled(
        start(
          number,
          pending.decision.state,
          { executor: 'mention', head: pr.head.value, attempt: null },
          'You mentioned `@claude` on its pull request, so the factory starts Claude to answer it.',
        ),
      );
    }
  }

  return pending;
}

function core(context: Context, ticket: TicketState | null, pr: PullRequestState | null): Pending {
  const { number } = context.state;
  const held = handedOver(ticket, pr);

  if (pr !== null && pr.status === 'merged' && pr.merged !== null)
    return settled(merged(context, held, pr.merged));

  if (ticket !== null && !ticket.open) {
    if (ticket.closed !== null && ticket.closed.merged && ticket.closed.commit !== null) {
      return settled(
        merged(context, held, {
          commit: ticket.closed.commit,
          at: ticket.closed.at,
          deployed: ticket.closed.deployed,
        }),
      );
    }

    return settled(
      wait(number, 'deployed', 'It was closed without a merged change, so nothing is left to do.'),
    );
  }

  if (pr !== null && pr.status === 'open') return settled(onPullRequest(context, ticket, pr));

  if (ticket !== null) return beforePullRequest(context, ticket);

  return settled(
    wait(
      number,
      'deployed',
      'Its pull request was closed without merging, so nothing is left to do.',
    ),
  );
}

/** Why a start can't be asked for now: the runs can't be read, or the dispatch budget is spent. */
function refusal(state: WorkItemState, policy: Policy, executor: RunKind): string | null {
  if (!state.runs.known) {
    return `It would start the ${executor} Executor, but its Executor runs couldn't be read (${state.runs.missing}), so the factory starts nothing until it can tell what is running.`;
  }

  const { item, all } = state.runs.value.startedLastDay;

  if (item >= policy.budget.item) {
    return `It would start the ${executor} Executor, but it has had ${item} Executor starts in 24 hours, the dispatch budget's limit, so the factory starts nothing more for it.`;
  }

  if (all >= policy.budget.all) {
    return `It would start the ${executor} Executor, but the factory has made ${all} Executor starts in 24 hours, the dispatch budget's limit for all Work items, so it starts nothing more.`;
  }

  return null;
}

/** The decision, with a start the budget or unreadable runs refuse turned into a wait. */
function guarded(state: WorkItemState, policy: Policy, decided: Decision): Decision {
  if (decided.action.type !== 'start') return decided;

  const refused = refusal(state, policy, decided.action.executor);

  return refused === null ? decided : wait(decided.number, decided.state, refused);
}

/**
 * Every open Work item's state, next step and reason. Tickets are built one at a time (ADR-0047):
 * a Ticket in flight (from its build until it's Deployed) holds the slot, and a free slot goes to
 * the Owner's Tickets before the nightly run's, each oldest Approval first (ADR-0052). A Work item
 * handed over or waiting for answers holds nothing (ADR-0075).
 */
export function decide(states: readonly WorkItemState[], policy: Policy): Decision[] {
  const pending = states.map((state) => ({ state, ...decideItem(state, policy) }));

  const inFlight = pending.flatMap((item) =>
    item.wantsSlot === null &&
    item.state.ticket.known &&
    item.state.ticket.value !== null &&
    IN_FLIGHT.includes(item.decision.state)
      ? [item.state.number]
      : [],
  );

  const queue = pending
    .filter((item) => item.wantsSlot !== null && refusal(item.state, policy, 'build') === null)
    .sort(
      (a, b) =>
        Number(a.wantsSlot?.nightly) - Number(b.wantsSlot?.nightly) ||
        Date.parse(a.wantsSlot?.at ?? '') - Date.parse(b.wantsSlot?.at ?? '') ||
        a.state.number - b.state.number,
    );

  // A Work item whose Ticket or pull request couldn't be read may be the one in flight, so it
  // holds the slot until it can be read: nothing fails open (ADR-0047's one at a time).
  const unreadable = pending.flatMap((item) =>
    !item.state.ticket.known || !item.state.pullRequest.known ? [item.state.number] : [],
  );

  const started =
    inFlight.length === 0 && unreadable.length === 0 ? queue[0]?.state.number : undefined;

  return pending.map((item) => {
    if (item.wantsSlot === null) return guarded(item.state, policy, item.decision);

    // Not built yet, so it waits, whether for the budget or for the slot.
    const refused = refusal(item.state, policy, 'build');

    if (refused !== null) return wait(item.state.number, 'waiting', refused);

    if (item.state.number === started) return item.decision;

    if (started === undefined && inFlight.length === 0) {
      return wait(
        item.state.number,
        'waiting',
        `The factory builds one Ticket at a time, and ${refs(unreadable)} couldn't be read, so it may be in flight: the factory starts no build until it can read it again.`,
      );
    }

    const ahead = started === undefined ? inFlight : [started];

    return wait(
      item.state.number,
      'waiting',
      started === undefined
        ? `The factory builds one Ticket at a time, and ${refs(ahead)} is in flight until it is Deployed.`
        : `The factory builds one Ticket at a time and starts ${refs(ahead)} first, so this one waits behind it.`,
    );
  });
}
