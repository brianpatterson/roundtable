// why <n>: one Work item's state, action and reason, the facts they came from, and how close it is
// to the dispatch budget, as lines for the Owner's terminal (README.md). Pure: it prints what
// `observe` and `decide` made, and writes nothing.

import type { Action, Decision } from './decide.ts';
import type { Policy } from './policy.ts';
import type { Fact, PullRequestState, TicketState, WorkItemState } from './state.ts';

const short = (sha: string): string => sha.slice(0, 7);

const list = (items: readonly string[]): string => (items.length === 0 ? 'none' : items.join('; '));

/** A fact's text, or `unknown` with what was missing. */
function told<T>(fact: Fact<T>, tell: (value: T) => string): string {
  return fact.known ? tell(fact.value) : `unknown (${fact.missing})`;
}

/** The action in words. */
export function describeAction(action: Action): string {
  switch (action.type) {
    case 'nothing':
      return 'nothing';
    case 'start': {
      const attempt = action.minor
        ? "Rework's Minor pass"
        : action.attempt === null
          ? 'not an Attempt'
          : `attempt ${action.attempt}`;

      return `start the ${action.executor} Executor (head ${action.head === null ? '-' : short(action.head)}, ${attempt})`;
    }

    case 'hand-over':
      return 'hand over: label it `needs-human`';
    case 'withdraw':
      return "withdraw the Approval: take the Owner's `ready` off";
    case 'rerun':
      return `rerun ${action.checks.join(', ')} on ${short(action.head)}`;
  }
}

function ticketLines(ticket: TicketState | null): string[] {
  if (ticket === null) return ['Ticket: none'];

  const ready = ticket.ready;

  const approval =
    ready === null
      ? 'none: not labeled `ready`'
      : ready.approved
        ? `\`ready\` by ${ready.by} at ${ready.at}, an Approval since ${ready.since ?? ready.at}${ready.voided ? ', voided: edited by someone else since' : ''}${ready.nightly ? ", the nightly run's" : ''}`
        : `\`ready\` by ${ready.by} at ${ready.at}, not an Approval`;

  const blockers = told(ticket.blockers, (value) =>
    list(
      value.map((blocker) => {
        const status =
          blocker.status === 'merged'
            ? `merged, ${told(blocker.deployed, (deployed) => (deployed ? 'Deployed' : 'not Deployed'))}`
            : blocker.status === 'unmerged'
              ? 'closed without a merged pull request'
              : 'open';

        return `#${blocker.number} ${status}${blocker.held === null ? '' : ` (\`${blocker.held}\`)`}`;
      }),
    ),
  );

  return [
    `Ticket: #${ticket.number} ${ticket.open ? 'open' : 'closed'}, labels ${list(ticket.labels.map((label) => `\`${label}\``))}`,
    `Approval: ${approval}`,
    `Blockers: ${blockers}`,
  ];
}

function pullRequestLines(pr: PullRequestState | null): string[] {
  if (pr === null) return ['Pull request: none'];

  const head = told(pr.head, (sha) => {
    const at = pr.headAt.known ? `, committed ${pr.headAt.value}` : '';

    return `${short(sha)}${at}`;
  });

  const checks = told(pr.checks, (value) =>
    list(
      value.map((check) => {
        const how =
          check.status === 'completed' ? (check.conclusion ?? 'no conclusion') : check.status;

        return `${check.name} ${how}${check.runs > 1 ? ` (run ${check.runs} times)` : ''}`;
      }),
    ),
  );

  const review = told(pr.review, (value) =>
    value === null
      ? 'none'
      : `${value.verdict} on ${short(value.commit)} at ${value.at}${value.minor === null ? '' : `, ${value.minor} minor findings`}`,
  );

  const attempts = told(pr.attempts, (value) => {
    const conflict =
      value.conflict.length === 0
        ? '0'
        : value.conflict
            .map((entry) => `${entry.count} on main at ${short(entry.main)}`)
            .join(', ');

    return `CI fix ${value.ciFix}, Rework ${value.rework}, Minor passes ${value.minorPasses} since ${value.since === null ? 'the pull request opened' : `the human push at ${value.since}`}; conflict ${conflict}`;
  });

  return [
    `Pull request: #${pr.number} ${pr.status}, by ${pr.author}, labels ${list(pr.labels.map((label) => `\`${label}\``))}`,
    `Head: ${head}`,
    `Mergeable: ${told(pr.mergeable, (value) => value)}`,
    `Checks: ${checks}`,
    `Review: ${review}`,
    `Attempts: ${attempts}`,
  ];
}

/** The lines `why` prints for one Work item. */
export function why(decision: Decision, state: WorkItemState, policy: Policy): string[] {
  const runs = state.runs;

  const executorRuns = told(runs, (value) => {
    const active = value.active.map((run) => `${run.name} ${run.status}`);
    const finished = value.finished.map((run) => `${run.name} asked for at ${run.createdAt}`);

    return `running ${list(active)}; finished in 24 hours ${list(finished)}`;
  });

  const budget = told(
    runs,
    (value) =>
      `${value.startedLastDay.item} of ${policy.budget.item} Executor starts for this Work item, and ${value.startedLastDay.all} of ${policy.budget.all} in all, in 24 hours`,
  );

  return [
    `#${decision.number}: ${decision.state}`,
    `Action: ${describeAction(decision.action)}`,
    `Reason: ${decision.reason}`,
    `At: ${state.at}`,
    ...(state.ticket.known
      ? ticketLines(state.ticket.value)
      : [`Ticket: unknown (${state.ticket.missing})`]),
    ...(state.pullRequest.known
      ? pullRequestLines(state.pullRequest.value)
      : [`Pull request: unknown (${state.pullRequest.missing})`]),
    `Executor runs: ${executorRuns}`,
    `Dispatch budget: ${budget}`,
  ];
}
