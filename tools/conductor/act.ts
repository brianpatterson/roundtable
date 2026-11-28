// act: carries out `decide`'s decisions with as few writes as possible (ADR-0075, ADR-0076). The
// only code here that writes to GitHub (README.md). `plan` is pure: from one Work item's decision,
// its state and the surface `gather` read, it lists the writes that make GitHub show the decision,
// and none that GitHub already shows. `act` makes them, or with `--dry-run` prints them.

import type { Action, Decision, StateName } from './decide.ts';
import type { GitHub } from './gather.ts';
import { type JsonObject, Read, type Json } from './json.ts';
import { CONDUCTOR, STATE } from './markers.ts';
import { type RunKind, parseRunName } from './run-name.ts';
import type { PullRequestState, TicketState, WorkItemState } from './state.ts';

/**
 * The workflow each kind of Executor is started through, by `workflow_dispatch` on `main`, with the
 * inputs `item`, `kind`, `sha` and `attempt` (README.md). The Owner's wiring must match it.
 */
export const WORKFLOWS: Readonly<Record<RunKind, string>> = {
  build: 'factory.yml',
  'ci-fix': 'factory.yml',
  review: 'review.yml',
  rework: 'rework.yml',
  conflict: 'resolve-conflicts.yml',
  mention: 'factory.yml',
};

/** The states in which a Ticket is labeled `building`: from its build until it's Deployed. */
const BUILDING: readonly StateName[] = [
  'building',
  'checking',
  'fixing',
  'reviewing',
  'reworking',
  'resolving',
  'reviewed',
  'merged',
];

/** The states that take `building` off a Ticket. */
const NOT_BUILDING: readonly StateName[] = ['deployed', 'needs-human'];

/** Run conclusions that aren't an Executor stopping. */
const FINISHED = ['success', 'skipped', 'neutral'];

/** GitHub rejects a commit status description over 140 characters. */
const DESCRIPTION = 140;

export interface Request {
  readonly method: 'POST' | 'PATCH' | 'DELETE';
  /** The path under `https://api.github.com`. */
  readonly path: string;
  readonly body: JsonObject | null;
}

export interface Write {
  /** The Work item it's for. */
  readonly item: number;
  /** One line saying what it changes: what `--dry-run` prints, and a failure names. */
  readonly what: string;
  /** The request, or why it can't be made. */
  readonly request: Request | { readonly refused: string };
  /** Made when this write fails, to take back what was written for it before. */
  readonly undo: Write | null;
}

/** What `act` reads before it writes, as GitHub shows it now (`OpenWorkItem.surface`). */
export interface Surface {
  /** The issue or pull request it comments on: the Ticket, or the pull request without one. */
  readonly target: number;
  readonly stateComment: { readonly id: number; readonly body: string } | null;
  /** The body of the latest `<!-- factory-conductor -->` comment, which isn't posted again. */
  readonly said: string | null;
  readonly checkRuns: readonly {
    readonly name: string;
    readonly startedAt: number | null;
    readonly run: number | null;
  }[];
  readonly runs: readonly {
    readonly name: string;
    readonly id: number;
    readonly conclusion: string;
    readonly createdAt: number;
  }[];
}

/** Parses the surface `gather` read. Throws `Missing` when it isn't one. */
export function readSurface(json: Json): Surface {
  const read = new Read(json, 'surface');
  const comment = read.field('stateComment');

  return {
    target: read.field('target').number(),
    stateComment: comment.absent()
      ? null
      : { id: comment.field('id').number(), body: comment.field('body').text() },
    said: read.field('said').optionalText(),
    checkRuns: read
      .field('checkRuns')
      .items()
      .map((check) => ({
        name: check.field('name').text(),
        startedAt: check.field('started_at').optionalTime(),
        run: check.field('run').absent() ? null : check.field('run').number(),
      })),
    runs: read
      .field('runs')
      .items()
      .map((run) => ({
        name: run.field('display_title').text(),
        id: run.field('id').number(),
        conclusion: run.field('conclusion').text(),
        createdAt: run.field('created_at').time(),
      })),
  };
}

const short = (sha: string): string => sha.slice(0, 7);

const sameCommit = (a: string, b: string): boolean =>
  a !== '' && b !== '' && (a.startsWith(b) || b.startsWith(a));

/** The `<!-- factory-state -->` comment's body for a state, its reason and when it was set. */
export function stateBody(state: StateName, reason: string, at: string): string {
  return `${STATE}\n**State:** \`${state}\`\n${reason}\n\n<sub>Since ${at}: the factory's Conductor, ADR-0075.</sub>`;
}

/** The state and reason a `<!-- factory-state -->` comment shows, or `null` for one it can't read. */
function shown(body: string): { readonly state: string; readonly reason: string } | null {
  const [marker, state = '', reason = ''] = body.split('\n');
  const name = /^\*\*State:\*\* `([a-z-]+)`$/.exec(state)?.[1];

  return marker === STATE && name !== undefined ? { state: name, reason } : null;
}

export interface FactoryStatus {
  readonly state: 'pending' | 'success' | 'error';
  readonly description: string;
  readonly url: string | null;
}

/** The description of a `reviewed` pull request's status, in ADR-0063's words. */
function reviewedDescription(pr: PullRequestState, head: string): string {
  if (pr.dependabotOnly) return 'Done: CI passed, your turn';

  const review = pr.review.known ? pr.review.value : null;

  if (review === null || !sameCommit(review.commit, head)) return 'Done: your turn';

  if (review.verdict === 'changes') return 'Done: changes needed, your turn';

  return (review.minor ?? 0) > 0
    ? 'Done: ready for you, with minor findings'
    : 'Done: ready for you';
}

/**
 * The `factory` status for a pull request's head (ADR-0063): success when it's the Owner's turn,
 * error when the Executor run of this head that finished last stopped, pending otherwise.
 */
export function factoryStatus(
  decision: Decision,
  state: WorkItemState,
  pr: PullRequestState,
  surface: Surface,
  repository: string,
): FactoryStatus | null {
  if (!pr.head.known) return null;

  const head = pr.head.value;

  if (decision.state === 'needs-human')
    return { state: 'success', description: 'Done: needs-human, your turn', url: null };

  if (decision.state === 'reviewed')
    return { state: 'success', description: reviewedDescription(pr, head), url: null };

  // A pull request the factory doesn't look after, waiting on the Owner (Dependabot's, CI failed).
  if (decision.ownersTurn === true)
    return { state: 'success', description: `Done: ${decision.state}, your turn`, url: null };

  const working: FactoryStatus = {
    state: 'pending',
    description: `Working: ${decision.state}`,
    url: null,
  };

  const active = state.runs.known && state.runs.value.active.length > 0;

  if (active || decision.action.type === 'start' || decision.action.type === 'rerun')
    return working;

  const last = surface.runs
    .filter((run) => {
      const sha = parseRunName(run.name)?.sha ?? null;

      return sha !== null && sameCommit(sha, head);
    })
    .sort((a, b) => a.createdAt - b.createdAt)
    .at(-1);

  if (last !== undefined && !FINISHED.includes(last.conclusion)) {
    return {
      state: 'error',
      description: `Stopped: ${last.name} ended ${last.conclusion}`,
      url: `https://github.com/${repository}/actions/runs/${last.id}`,
    };
  }

  return working;
}

const truncate = (text: string): string =>
  text.length <= DESCRIPTION ? text : `${text.slice(0, DESCRIPTION - 3)}...`;

/** The `attempt` input: the Attempt's number, `minor` for Rework's Minor pass, or empty. */
const attemptInput = (action: Extract<Action, { type: 'start' }>): string =>
  action.minor ? 'minor' : action.attempt === null ? '' : String(action.attempt);

export interface Plan {
  readonly decision: Decision;
  readonly state: WorkItemState;
  readonly surface: Surface;
  readonly repository: string;
  /** The time `run` read once at its start, as an ISO timestamp. */
  readonly at: string;
}

/** A label added to or taken off an issue or pull request. */
function labelWrite(
  item: number,
  repository: string,
  number: number,
  change: 'add' | 'remove',
  labels: readonly string[],
): Write[] {
  if (labels.length === 0) return [];

  if (change === 'add') {
    return [
      {
        item,
        what: `label #${number} ${labels.join(', ')}`,
        request: {
          method: 'POST',
          path: `/repos/${repository}/issues/${number}/labels`,
          body: { labels: [...labels] },
        },
        undo: null,
      },
    ];
  }

  return labels.map((label) => ({
    item,
    what: `unlabel #${number} ${label}`,
    request: {
      method: 'DELETE',
      path: `/repos/${repository}/issues/${number}/labels/${encodeURIComponent(label)}`,
      body: null,
    },
    undo: null,
  }));
}

/** The labels a decision adds to and takes off the Ticket and the pull request, that aren't so yet. */
interface LabelChanges {
  readonly ticketAdd: readonly string[];
  readonly ticketRemove: readonly string[];
  readonly prAdd: readonly string[];
}

function labelChanges(
  decision: Decision,
  ticket: TicketState | null,
  pr: PullRequestState | null,
): LabelChanges {
  const ticketAdd = new Set<string>();
  const ticketRemove = new Set<string>();
  const prAdd = new Set<string>();
  const action = decision.action;

  if (action.type === 'hand-over') {
    if (ticket !== null) ticketAdd.add('needs-human');
    else if (pr !== null) prAdd.add('needs-human');

    ticketRemove.add('building');
  }

  if (action.type === 'withdraw') ticketRemove.add('ready');

  // An answered Ticket's questions are settled once it's built again (`dispatch.sh`).
  if (action.type === 'start' && action.executor === 'build') ticketRemove.add('needs-info');

  if (BUILDING.includes(decision.state)) ticketAdd.add('building');

  if (NOT_BUILDING.includes(decision.state)) ticketRemove.add('building');

  const ticketLabels = ticket?.labels ?? [];

  return {
    ticketAdd:
      ticket === null
        ? []
        : [...ticketAdd].filter(
            (label) => !ticketLabels.includes(label) && !ticketRemove.has(label),
          ),
    ticketRemove: ticket === null ? [] : [...ticketRemove].filter((l) => ticketLabels.includes(l)),
    prAdd: pr === null ? [] : [...prAdd].filter((label) => !pr.labels.includes(label)),
  };
}

/** The writes that start an Executor or rerun checks. */
function actionWrites(plan: Plan, undo: Write | null): Write[] {
  const { decision, repository, surface } = plan;
  const action = decision.action;
  const item = decision.number;

  if (action.type === 'start') {
    const workflow = WORKFLOWS[action.executor];

    const inputs = {
      item: String(action.item),
      kind: action.executor,
      sha: action.head ?? '',
      attempt: attemptInput(action),
    };

    return [
      {
        item,
        what: `start the ${action.executor} Executor for #${action.item} through ${workflow} (sha ${inputs.sha === '' ? '-' : short(inputs.sha)}, attempt ${inputs.attempt === '' ? '-' : inputs.attempt})`,
        request: {
          method: 'POST',
          path: `/repos/${repository}/actions/workflows/${workflow}/dispatches`,
          body: { ref: 'main', inputs },
        },
        undo,
      },
    ];
  }

  if (action.type === 'rerun') {
    const runs = new Map<number, string[]>();
    const refused: Write[] = [];

    for (const name of action.checks) {
      const latest = surface.checkRuns
        .filter((check) => check.name === name)
        .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
        .at(-1);

      if (latest?.run === undefined || latest.run === null) {
        refused.push({
          item,
          what: `rerun the check ${name} on ${short(action.head)}`,
          request: { refused: 'no Actions run made it, so there is nothing to rerun' },
          undo: null,
        });
        continue;
      }

      runs.set(latest.run, [...(runs.get(latest.run) ?? []), name]);
    }

    // One rerun per Actions run, however many of its checks ended.
    const reruns = [...runs].map(([run, names]): Write => ({
      item,
      what: `rerun the run ${run} of ${names.join(', ')} on ${short(action.head)}`,
      request: {
        method: 'POST',
        path: `/repos/${repository}/actions/runs/${run}/rerun-failed-jobs`,
        body: null,
      },
      undo: null,
    }));

    return [...reruns, ...refused];
  }

  return [];
}

/** The writes that make GitHub show one Work item's decision; none that it already shows. */
export function plan(input: Plan): Write[] {
  const { decision, state, surface, repository, at } = input;
  const item = decision.number;
  const action = decision.action;

  const ticket =
    state.ticket.known && state.ticket.value !== null && state.ticket.value.open
      ? state.ticket.value
      : null;

  const pr =
    state.pullRequest.known &&
    state.pullRequest.value !== null &&
    state.pullRequest.value.status === 'open'
      ? state.pullRequest.value
      : null;

  const labels = labelChanges(decision, ticket, pr);
  const writes: Write[] = [];

  if (ticket !== null) {
    writes.push(...labelWrite(item, repository, ticket.number, 'add', labels.ticketAdd));
    writes.push(...labelWrite(item, repository, ticket.number, 'remove', labels.ticketRemove));
  }

  if (pr !== null) writes.push(...labelWrite(item, repository, pr.number, 'add', labels.prAdd));

  // A build that doesn't start takes back the `building` label added for it: builds count from
  // that label, so a stale one would hold the Ticket until the stale build time.
  const undo =
    ticket !== null &&
    action.type === 'start' &&
    action.executor === 'build' &&
    labels.ticketAdd.includes('building')
      ? (labelWrite(item, repository, ticket.number, 'remove', ['building'])[0] ?? null)
      : null;

  writes.push(...actionWrites(input, undo));

  if (action.type === 'hand-over' || action.type === 'withdraw') {
    const body = `${CONDUCTOR}\n${action.reason}`;

    if (surface.said !== body) {
      writes.push({
        item,
        what: `comment on #${surface.target}: ${action.reason}`,
        request: {
          method: 'POST',
          path: `/repos/${repository}/issues/${surface.target}/comments`,
          body: { body },
        },
        undo: null,
      });
    }
  }

  if (pr !== null) writes.push(...statusWrites(input, pr));

  writes.push(...stateCommentWrites(item, decision, surface, repository, at));

  return writes;
}

function statusWrites(input: Plan, pr: PullRequestState): Write[] {
  const { decision, state, surface, repository } = input;
  const wanted = factoryStatus(decision, state, pr, surface, repository);

  if (wanted === null || !pr.head.known) return [];

  const head = pr.head.value;
  const description = truncate(wanted.description);

  const current = pr.statuses.known
    ? pr.statuses.value.find((status) => status.context === 'factory')
    : undefined;

  if (
    current !== undefined &&
    current.state === wanted.state &&
    current.description === description
  )
    return [];

  return [
    {
      item: decision.number,
      what: `set the factory status on ${short(head)}: ${wanted.state}, "${description}"`,
      request: {
        method: 'POST',
        path: `/repos/${repository}/statuses/${head}`,
        body: {
          context: 'factory',
          state: wanted.state,
          description,
          // GitHub takes `null` for a status that links nowhere.
          target_url: wanted.url,
        },
      },
      undo: null,
    },
  ];
}

/**
 * A reason with its minute counts taken out: a wait that counts minutes ("running for 31 minutes")
 * reads differently every run while nothing on GitHub has changed, and isn't worth an edit.
 */
const withoutMinutes = (reason: string): string => reason.replaceAll(/\d+ minutes/g, 'N minutes');

function stateCommentWrites(
  item: number,
  decision: Decision,
  surface: Surface,
  repository: string,
  at: string,
): Write[] {
  const existing = surface.stateComment;
  const now = existing === null ? null : shown(existing.body);

  if (
    now !== null &&
    now.state === decision.state &&
    withoutMinutes(now.reason) === withoutMinutes(decision.reason)
  )
    return [];

  // Once handed over, the comment keeps the reason it was handed over for, not "it waits for you".
  if (
    now?.state === 'needs-human' &&
    decision.state === 'needs-human' &&
    decision.action.type === 'nothing'
  )
    return [];

  const body = stateBody(decision.state, decision.reason, at);

  if (existing === null) {
    return [
      {
        item,
        what: `post the state comment on #${surface.target}: ${decision.state}`,
        request: {
          method: 'POST',
          path: `/repos/${repository}/issues/${surface.target}/comments`,
          body: { body },
        },
        undo: null,
      },
    ];
  }

  return [
    {
      item,
      what: `edit the state comment on #${surface.target}: ${decision.state}`,
      request: {
        method: 'PATCH',
        path: `/repos/${repository}/issues/comments/${existing.id}`,
        body: { body },
      },
      undo: null,
    },
  ];
}

/** Makes one write; returns why it failed, or `null`. */
async function make(github: GitHub, write: Write): Promise<string | null> {
  const request = write.request;

  if ('refused' in request) return request.refused;

  try {
    const response = await github.fetch(`https://api.github.com${request.path}`, {
      method: request.method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${github.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'roundtable-conductor',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: request.body === null ? null : JSON.stringify(request.body),
    });

    return response.ok ? null : `GitHub answered ${response.status}`;
  } catch (error) {
    return `GitHub couldn't be reached: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export interface ActOptions {
  /** Print each write instead of making it. */
  readonly dryRun: boolean;
  readonly out: (line: string) => void;
}

/**
 * Makes the writes in order, going on past one that fails, and prints each as `#<item>: <what>`.
 * Returns each failed write, with why; with `dryRun`, it makes none and returns none.
 */
export async function act(
  github: GitHub,
  writes: readonly Write[],
  options: ActOptions,
): Promise<string[]> {
  const failed: string[] = [];

  for (const write of writes) {
    options.out(`#${write.item}: ${write.what}`);

    if (options.dryRun) continue;

    const why = await make(github, write);

    if (why === null) continue;

    failed.push(`#${write.item}: ${write.what}: ${why}`);

    if (write.undo !== null) {
      options.out(`#${write.undo.item}: ${write.undo.what}`);

      const undone = await make(github, write.undo);

      if (undone !== null) failed.push(`#${write.undo.item}: ${write.undo.what}: ${undone}`);
    }
  }

  return failed;
}
