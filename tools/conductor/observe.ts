// Builds a Work item's state as it was at time `at` from `gather`'s raw answers, reading only
// events at or before `at`. Pure: the same raw and `at` always give the same state, and it never
// throws: a part it can't read is `unknown`, with what was missing.

import { type Json, Missing, Read } from './json.ts';
import { REVIEW, REVIEW_CHANGES, CI_FIX, CONFLICT, REWORK, REWORK_MINOR } from './markers.ts';
import { type RawWorkItem, closerCommit, isExecutorRun } from './raw.ts';
import { parseRunName } from './run-name.ts';
import type {
  ActiveRun,
  Attempts,
  BlockerState,
  CheckState,
  Closure,
  CommitStatus,
  Fact,
  Held,
  PullRequestState,
  Ready,
  Review,
  RunsState,
  TicketState,
  WorkItemState,
} from './state.ts';

const DAY = 24 * 60 * 60 * 1000;

/** A part of the state, or `unknown` with what stopped it being read. */
function fact<T>(read: () => T): Fact<T> {
  try {
    return { known: true, value: read() };
  } catch (error) {
    return { known: false, missing: error instanceof Error ? error.message : String(error) };
  }
}

const iso = (time: number): string => new Date(time).toISOString();

/** One timeline event. */
interface Event {
  readonly type: string;
  readonly at: number;
  readonly label: string | null;
  readonly actor: string | null;
  readonly read: Read;
}

/** The events at or before `when`, oldest first. */
function eventsUntil(timeline: Read, when: number): Event[] {
  return timeline
    .items()
    .map((read) => ({
      type: read.field('__typename').text(),
      at: read.field('createdAt').time(),
      label: read.field('label').absent() ? null : read.field('label').field('name').text(),
      actor: read.field('actor').field('login').optionalText(),
      read,
    }))
    .filter((event) => event.at <= when)
    .sort((a, b) => a.at - b.at);
}

/** The labels after the labeled and unlabeled events, in the order they were added. */
function labelsAfter(events: readonly Event[]): string[] {
  const labels = new Set<string>();

  for (const event of events) {
    if (event.label === null) continue;

    if (event.type === 'LabeledEvent') labels.add(event.label);

    if (event.type === 'UnlabeledEvent') labels.delete(event.label);
  }

  return [...labels];
}

/** Whether an issue is open after its closed and reopened events. */
function openAfter(events: readonly Event[]): boolean {
  let open = true;

  for (const event of events) {
    if (event.type === 'ClosedEvent' || event.type === 'MergedEvent') open = false;

    if (event.type === 'ReopenedEvent') open = true;
  }

  return open;
}

function heldBy(labels: readonly string[], answered: boolean): Held | null {
  if (labels.includes('needs-human')) return 'needs-human';

  if (labels.includes('needs-info') && !answered) return 'needs-info';

  return null;
}

/** What a run of observe reads once: when each successful deploy completed, and what each includes. */
interface Deploys {
  readonly completed: ReadonlyMap<string, number>;
  readonly inclusions: readonly { commit: string; deploy: string; status: string }[];
}

function readDeploys(raw: RawWorkItem): Deploys {
  const completed = new Map<string, number>();

  for (const deploy of new Read(raw.deploys, 'deploys').items()) {
    const sha = deploy.field('head_sha').text();
    const at = deploy.field('updated_at').time();

    completed.set(sha, Math.min(at, completed.get(sha) ?? at));
  }

  const inclusions = new Read(raw.inclusions, 'inclusions').items().map((inclusion) => ({
    commit: inclusion.field('commit').text(),
    deploy: inclusion.field('deploy').text(),
    status: inclusion.field('status').text(),
  }));

  return { completed, inclusions };
}

/** Whether a successful deploy that completed at or before `when` includes `commit`. */
function deployedAt(deploys: Fact<Deploys>, commit: string, when: number): Fact<boolean> {
  if (!deploys.known) return deploys;

  return fact(() =>
    deploys.value.inclusions.some(
      (inclusion) =>
        inclusion.commit === commit &&
        (inclusion.status === 'ahead' || inclusion.status === 'identical') &&
        (deploys.value.completed.get(inclusion.deploy) ?? Infinity) <= when,
    ),
  );
}

/** How an issue was closed the last time by `when`, from its closed events. */
function closureOf(events: readonly Event[], deploys: Fact<Deploys>, when: number): Closure {
  const closed = events.filter((event) => event.type === 'ClosedEvent').at(-1);
  const closer = closed?.read.field('closer');

  if (closer === undefined || closer.absent()) {
    return { merged: false, commit: null, deployed: { known: true, value: false } };
  }

  const commit = closerCommit(closer);

  if (commit === null)
    return { merged: false, commit: null, deployed: { known: true, value: false } };

  return { merged: true, commit, deployed: deployedAt(deploys, commit, when) };
}

function blockerAt(blocker: Read, deploys: Fact<Deploys>, when: number): BlockerState | null {
  // An issue opened after `when` blocked nothing then.
  if (blocker.field('createdAt').time() > when) return null;

  const events = eventsUntil(blocker.field('timeline'), when);
  const labels = labelsAfter(events);
  const number = blocker.field('number').number();
  const held = heldBy(labels, false);

  if (openAfter(events))
    return { number, status: 'open', deployed: { known: true, value: false }, held, labels };

  const closure = closureOf(events, deploys, when);

  return closure.merged
    ? { number, status: 'merged', deployed: closure.deployed, held, labels }
    : { number, status: 'unmerged', deployed: { known: true, value: false }, held, labels };
}

/** The Ticket's latest `ready` label at `when`, read by `dispatch.sh`'s rules. */
function readyAt(
  ticket: Read,
  events: readonly Event[],
  labels: readonly string[],
  owner: string,
  when: number,
): Ready | null {
  const ready = events
    .filter((event) => event.type === 'LabeledEvent' && event.label === 'ready')
    .at(-1);

  if (ready === undefined || !labels.includes('ready')) return null;

  // A Mutation ticket the nightly run opened (GraphQL names its token "github-actions") is approved
  // by that workflow's own label (ADR-0051).
  const author = ticket.field('author').field('login').optionalText() ?? '';
  const nightly = labels.includes('mutation') && author === 'github-actions';

  const approver = (login: string | null): boolean =>
    login === owner || (nightly && login === 'github-actions');

  // When the Approval began: the `ready` events in order, restarting after the workflow removes it.
  let since: number | null = null;

  for (const event of events) {
    if (event.label !== 'ready') continue;

    if (event.type === 'UnlabeledEvent' && event.actor !== owner) since = null;
    else if (event.type === 'LabeledEvent' && since === null && approver(event.actor))
      since = event.at;
  }

  const from = since ?? ready.at;

  const editedAfter = ticket
    .field('edits')
    .items()
    .some((edit) => {
      const at = edit.field('editedAt').time();

      return (
        at > from && at <= when && edit.field('editor').field('login').optionalText() !== owner
      );
    });

  const renamedAfter = events.some(
    (event) => event.type === 'RenamedTitleEvent' && event.at > from && event.actor !== owner,
  );

  return {
    by: ready.actor ?? '',
    at: iso(ready.at),
    approved: approver(ready.actor),
    nightly: nightly && ready.actor === 'github-actions',
    since: since === null ? null : iso(since),
    voided: editedAfter || renamedAfter,
  };
}

function ticketAt(raw: RawWorkItem, deploys: Fact<Deploys>, when: number): TicketState | null {
  const ticket = new Read(raw.ticket, 'ticket');

  if (ticket.absent() || ticket.field('createdAt').time() > when) return null;

  const events = eventsUntil(ticket.field('timeline'), when);
  const labels = labelsAfter(events);

  const lastLabeled = (name: string) =>
    events.filter((event) => event.type === 'LabeledEvent' && event.label === name).at(-1);

  const ready = lastLabeled('ready');
  const info = lastLabeled('needs-info');
  const building = lastLabeled('building');
  const answered = info !== undefined && ready !== undefined && ready.at > info.at;
  const open = openAfter(events);

  return {
    number: ticket.field('number').number(),
    open,
    closed: open ? null : closureOf(events, deploys, when),
    labels,
    ready: readyAt(ticket, events, labels, raw.owner, when),
    held: heldBy(labels, answered),
    answered: labels.includes('needs-info') && answered,
    building:
      labels.includes('building') && building !== undefined ? { since: iso(building.at) } : null,
    blockers: fact(() =>
      new Read(raw.blockers, 'blockers')
        .items()
        .map((blocker) => blockerAt(blocker, deploys, when))
        .filter((blocker): blocker is BlockerState => blocker !== null),
    ),
  };
}

/** A commit of the pull request: when it was committed, and whether a human wrote it. */
interface Commit {
  readonly sha: string;
  readonly at: number;
  readonly human: boolean;
}

/**
 * A human author has a GitHub login that isn't a bot's (`attempt.sh`): an author without one isn't
 * a person on GitHub, like merge-main.sh's `factory` commit or a `Co-Authored-By: Claude`.
 */
const isHuman = (login: string | null): boolean =>
  login !== null && login !== '' && !/^(claude|dependabot)|\[bot\]$/.test(login);

function commitsUntil(pr: Read, when: number): Commit[] {
  return pr
    .field('commits')
    .items()
    .map((node) => node.field('commit'))
    .map((commit) => ({
      sha: commit.field('oid').text(),
      at: commit.field('committedDate').time(),
      human: commit
        .field('authors')
        .field('nodes')
        .items()
        .some((author) =>
          isHuman(
            author.field('user').absent()
              ? null
              : author.field('user').field('login').optionalText(),
          ),
        ),
    }))
    .filter((commit) => commit.at <= when);
}

/** One of the factory's marker comments. */
interface Comment {
  readonly at: number;
  readonly body: string;
}

function commentsUntil(raw: RawWorkItem, when: number): Comment[] {
  return new Read(raw.comments, 'comments')
    .items()
    .flatMap((comment) => {
      // Only the workflow's own: anyone can comment on a public pull request.
      if (comment.field('user').field('login').optionalText() !== 'github-actions[bot]') return [];

      const at = comment.field('created_at').time();

      return at <= when ? [{ at, body: comment.field('body').text() }] : [];
    })
    .sort((a, b) => a.at - b.at);
}

/** The raw entry for one commit in `checks` or `statuses`. */
function forCommit(list: Json, name: string, sha: string): Read {
  const entry = new Read(list, name).items().find((item) => item.field('sha').text() === sha);

  if (entry === undefined) throw new Missing(`${name} weren't gathered for ${sha}`);

  return entry;
}

function checksAt(raw: RawWorkItem, head: string, when: number): CheckState[] {
  const latest = new Map<string, { started: number; check: CheckState }>();

  for (const run of forCommit(raw.checks, 'checks', head).field('checkRuns').items()) {
    const started = run.field('started_at').optionalTime();

    if (started === null || started > when) continue;

    const completed = run.field('completed_at').optionalTime();
    const name = run.field('name').text();

    const check: CheckState =
      completed !== null && completed <= when
        ? { name, status: 'completed', conclusion: run.field('conclusion').optionalText() }
        : {
            name,
            status: run.field('status').text() === 'queued' ? 'queued' : 'in_progress',
            conclusion: null,
          };

    const previous = latest.get(name);

    if (previous === undefined || previous.started <= started) latest.set(name, { started, check });
  }

  return [...latest.values()].map((entry) => entry.check);
}

const STATUS_STATES = ['error', 'failure', 'pending', 'success'] as const;

function statusState(read: Read): CommitStatus['state'] {
  const state = read.text();
  const known = STATUS_STATES.find((candidate) => candidate === state);

  if (known === undefined) throw new Missing(`${read.path} is not a commit status state`);

  return known;
}

function statusesAt(raw: RawWorkItem, head: string, when: number): CommitStatus[] {
  const latest = new Map<string, { at: number; status: CommitStatus }>();

  for (const read of forCommit(raw.statuses, 'statuses', head).field('statuses').items()) {
    const at = read.field('created_at').time();

    if (at > when) continue;

    const context = read.field('context').text();
    const previous = latest.get(context);

    if (previous !== undefined && previous.at > at) continue;

    latest.set(context, {
      at,
      status: {
        context,
        state: statusState(read.field('state')),
        description: read.field('description').optionalText() ?? '',
        at: iso(at),
      },
    });
  }

  return [...latest.values()].map((entry) => entry.status);
}

/** The Attempts made by `when`, counted as `attempt.sh` counts them. */
function attemptsAt(commits: readonly Commit[], comments: readonly Comment[]): Attempts {
  const human = commits.flatMap((commit) => (commit.human ? [commit.at] : []));
  const since = human.length === 0 ? null : Math.max(...human);
  const sinceHuman = comments.filter((comment) => since === null || comment.at > since);
  const rework = sinceHuman.filter((comment) => comment.body.startsWith(REWORK));
  const conflict = new Map<string, number>();

  for (const comment of comments) {
    if (!comment.body.startsWith(CONFLICT)) continue;

    // The resolver's footer: "merging main at <sha> into commit <sha>".
    const main = /merging main at ([0-9a-f]+)/.exec(comment.body)?.[1];

    if (main !== undefined) conflict.set(main, (conflict.get(main) ?? 0) + 1);
  }

  return {
    since: since === null ? null : iso(since),
    ciFix: sinceHuman.filter((comment) => comment.body.startsWith(CI_FIX)).length,
    rework: rework.filter((comment) => !comment.body.includes(REWORK_MINOR)).length,
    minorPasses: rework.filter((comment) => comment.body.includes(REWORK_MINOR)).length,
    conflict: [...conflict].map(([main, count]) => ({ main, count })),
  };
}

/** The Review as the reviewer's comment shows it now. */
function reviewNow(comments: readonly Comment[]): Review | null {
  const comment = comments.filter((candidate) => candidate.body.startsWith(REVIEW)).at(-1);

  if (comment === undefined) return null;

  // `post-review.sh` writes the heading right after the marker and its footer last; the review
  // between them is the reviewer's own text, which could hold a line like either.
  const lines = comment.body.split('\n');
  const heading = lines[1] ?? '';

  const footer = lines.filter((line) => line.startsWith('<sub>Commit ')).at(-1) ?? '';
  const commit = /^<sub>Commit ([0-9a-f]{7,40}),/.exec(footer)?.[1];

  if (commit === undefined) throw new Missing("the reviewer's comment names no commit");

  if (heading.startsWith('### Factory review: ✅ Ready for you'))
    return { verdict: 'ready', commit };

  if (heading.startsWith('### Factory review: ✋ Changes needed'))
    return { verdict: 'changes', commit };

  throw new Missing("the reviewer's comment has no verdict heading");
}

/**
 * The Review of `head` at a past moment, from what has timestamps: the `factory` status set after
 * each review (ADR-0063) and the comment a re-review asking for changes posts (ADR-0046).
 */
function reviewThen(
  raw: RawWorkItem,
  comments: readonly Comment[],
  head: string,
  when: number,
): Review {
  const signals: { at: number; verdict: Review['verdict'] }[] = [];

  for (const status of statusesAt(raw, head, when)) {
    if (status.context !== 'factory') continue;

    if (status.description.startsWith('Done: ready for you')) {
      signals.push({ at: Date.parse(status.at), verdict: 'ready' });
    } else if (status.description.startsWith('Done: changes needed')) {
      signals.push({ at: Date.parse(status.at), verdict: 'changes' });
    }
  }

  for (const comment of comments) {
    if (
      comment.body.startsWith(REVIEW_CHANGES) &&
      comment.body.includes(`Re-reviewed ${head.slice(0, 7)}: ✋`)
    ) {
      signals.push({ at: comment.at, verdict: 'changes' });
    }
  }

  const latest = signals.sort((a, b) => a.at - b.at).at(-1);

  if (latest === undefined) {
    throw new Missing(
      "the reviewer's comment shows only today's Review, and no factory status or changes comment says what it was then",
    );
  }

  return { verdict: latest.verdict, commit: head };
}

const MERGEABLE = ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] as const;

function pullRequestAt(
  raw: RawWorkItem,
  deploys: Fact<Deploys>,
  when: number,
  now: boolean,
): PullRequestState | null {
  const pr = new Read(raw.pullRequest, 'pullRequest');

  if (pr.absent() || pr.field('createdAt').time() > when) return null;

  const events = eventsUntil(pr.field('timeline'), when);
  const mergedEvent = events.find((event) => event.type === 'MergedEvent');

  const merged =
    mergedEvent === undefined
      ? null
      : fact(() => mergedEvent.read.field('commit').field('oid').text());

  const head = fact(() => {
    const last = commitsUntil(pr, when).at(-1);

    if (last === undefined)
      throw new Missing('no commit of the pull request was committed by then');

    return last.sha;
  });

  const comments = fact(() => commentsUntil(raw, when));

  const onHead = <T>(read: (sha: string) => T): Fact<T> =>
    head.known ? fact(() => read(head.value)) : head;

  return {
    number: pr.field('number').number(),
    author: pr.field('author').field('login').optionalText() ?? '',
    status: mergedEvent !== undefined ? 'merged' : openAfter(events) ? 'open' : 'closed',
    merged:
      mergedEvent === undefined || merged === null
        ? null
        : {
            at: iso(mergedEvent.at),
            commit: merged.known ? merged.value : '',
            deployed: merged.known ? deployedAt(deploys, merged.value, when) : merged,
          },
    labels: labelsAfter(events),
    head,
    mergeable: fact(() => {
      if (!now) throw new Missing('GitHub shows mergeability only as it is now');

      const value = pr.field('mergeable').text();
      const known = MERGEABLE.find((candidate) => candidate === value);

      if (known === undefined) throw new Missing(`pullRequest.mergeable is ${value}`);

      return known;
    }),
    checks: onHead((sha) => checksAt(raw, sha, when)),
    statuses: onHead((sha) => statusesAt(raw, sha, when)),
    attempts: comments.known
      ? fact(() => attemptsAt(commitsUntil(pr, when), comments.value))
      : comments,
    review: !comments.known
      ? comments
      : now
        ? fact(() => reviewNow(comments.value))
        : onHead((sha) => reviewThen(raw, comments.value, sha, when)),
  };
}

function runsAt(raw: RawWorkItem, when: number): RunsState {
  const active: ActiveRun[] = [];
  let item = 0;
  let all = 0;

  for (const run of new Read(raw.runs, 'runs').items()) {
    // Only a collaborator can start a `workflow_dispatch` run: anyone can title a pull request, and
    // so its CI runs, like an Executor run.
    if (!isExecutorRun(run)) continue;

    const name = run.field('display_title').text();
    const parsed = parseRunName(name);

    if (parsed === null) continue;

    const created = run.field('created_at').time();

    if (created > when) continue;

    const status = run.field('status').text();
    const mine = parsed.item === raw.number;

    if (created > when - DAY) {
      all += 1;

      if (mine) item += 1;
    }

    const finished = status === 'completed' && run.field('updated_at').time() <= when;

    if (mine && !finished) {
      // A run that hadn't started by `at` was queued then, whatever it is now.
      const started = run.field('run_started_at').optionalTime();

      const queued =
        ['queued', 'waiting', 'pending', 'requested'].includes(status) ||
        started === null ||
        started > when;

      active.push({
        name,
        kind: parsed.kind,
        sha: parsed.sha,
        status: queued ? 'queued' : 'in_progress',
      });
    }
  }

  return { active, startedLastDay: { item, all } };
}

const TIME_KEYS = [
  'createdAt',
  'editedAt',
  'committedDate',
  'created_at',
  'updated_at',
  'started_at',
  'completed_at',
];

/** The latest timestamp anywhere in a raw part. Never throws: what isn't a time is skipped. */
function latestIn(value: Json | undefined): number {
  const read = new Read(value, '');

  if (read.absent()) return -Infinity;

  if (Array.isArray(value))
    return Math.max(-Infinity, ...read.items().map((item) => latestIn(item.value)));

  if (!(value instanceof Object)) return -Infinity;

  let latest = -Infinity;

  for (const [key, child] of Object.entries(value)) {
    if (TIME_KEYS.includes(key)) {
      const time = Date.parse(String(child));

      if (!Number.isNaN(time)) latest = Math.max(latest, time);
    } else {
      latest = Math.max(latest, latestIn(child));
    }
  }

  return latest;
}

/** The Work item's latest event: before it, what GitHub shows only as it is now is unknown. */
const latestEvent = (raw: RawWorkItem): number =>
  Math.max(
    latestIn(raw.ticket),
    latestIn(raw.pullRequest),
    latestIn(raw.comments),
    latestIn(raw.checks),
    latestIn(raw.statuses),
  );

/** The Work item's state as it was at `at`, from events at or before it only. */
export function observe(raw: RawWorkItem, at: Date): WorkItemState {
  const when = at.getTime();

  if (Number.isNaN(when)) {
    const missing: Fact<never> = { known: false, missing: '`at` is not a time' };

    return {
      number: raw.number,
      at: 'Invalid Date',
      ticket: missing,
      pullRequest: missing,
      runs: missing,
    };
  }

  const deploys = fact(() => readDeploys(raw));
  const now = when >= latestEvent(raw);

  return {
    number: raw.number,
    at: iso(when),
    ticket: fact(() => ticketAt(raw, deploys, when)),
    pullRequest: fact(() => pullRequestAt(raw, deploys, when, now)),
    runs: fact(() => runsAt(raw, when)),
  };
}
