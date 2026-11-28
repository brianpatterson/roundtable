// The recorder's derivation (ADR-0075, ADR-0076): from what `gather` read about one Work item, every
// event in its life as a checkpoint, each with the step the factory took next. Pure: the raw answers
// are its only input, so the same raw always gives the same checkpoints. `fixture.ts` saves them.

import type { Action } from './decide.ts';
import { Read } from './json.ts';
import {
  CI_FIX,
  CONFLICT,
  DISPATCH,
  REVIEW,
  REVIEW_CHANGES,
  REWORK,
  REWORK_MINOR,
} from './markers.ts';
import { isHuman } from './observe.ts';
import { type RawWorkItem, isExecutorRun } from './raw.ts';
import { type RunKind, parseRunName } from './run-name.ts';

export type StartAction = Extract<Action, { readonly type: 'start' }>;

/**
 * The step the factory took after a checkpoint: `decide`'s own action, with the evidence that shows
 * it; or `unknown`, with why the events don't settle it, which the history test skips.
 */
export type Next =
  { readonly action: Action; readonly evidence: string } | { readonly unknown: string };

export interface Checkpoint {
  /** When the event happened, as an ISO timestamp: what `observe(raw, at)` is run with. */
  readonly at: string;
  /** What happened then, in a few words each. */
  readonly events: readonly string[];
  /**
   * Other Work items the dispatcher said were in flight then (its `<!-- factory-dispatch -->`
   * comment on the Ticket), so `decide` sees the queue the dispatcher did.
   */
  readonly building: readonly number[];
  readonly next: Next;
}

/** What the factory or the Owner did, as the events show it. */
type Evidence =
  /** An Executor started: a run named for it, a `factory` status, or the dispatcher's `building`. */
  | { readonly kind: 'start'; readonly action: StartAction }
  /**
   * An Executor's own work, whose start the events don't show: its marker comment or the end of its
   * Review (`end`), or what it did on the way there (a push, a `needs-human` before its comment).
   * `action` is `null` for a factory commit no Executor's comment claims.
   */
  | { readonly kind: 'done'; readonly action: StartAction | null; readonly end: boolean }
  | { readonly kind: 'hand-over' }
  | { readonly kind: 'withdraw' }
  | { readonly kind: 'rerun'; readonly head: string; readonly checks: readonly string[] }
  | { readonly kind: 'owner' };

interface Happening {
  readonly at: number;
  /** What happened, for the checkpoint's `events`; `null` for what isn't an event in its life. */
  readonly what: string | null;
  evidence: Evidence | null;
}

/** A named Executor run of this Work item: what `decide` itself sees as queued or running. */
interface NamedRun {
  readonly name: string;
  readonly kind: RunKind;
  readonly from: number;
  readonly to: number;
}

const iso = (time: number): string => new Date(time).toISOString();

const short = (sha: string): string => sha.slice(0, 7);

const MENTIONED = 'comment: the Owner mentioned `@claude`';

/** How long before its comment an Executor's `needs-human` is still its own (`attempt.sh` labels, then comments). */
const OWN_LABEL_MS = 5 * 60_000;

/** Reruns of a commit's checks started this close together are one rerun. */
const RERUN_GROUP_MS = 10 * 60_000;

/** A rerun this close to a CI fixer's comment is the CI fixer's ("re-ran the failed jobs"). */
const FIXER_RERUN_MS = 30 * 60_000;

/** The raw answers as `Read`s, with the pull request's commits read once. */
class Raw {
  readonly raw: RawWorkItem;
  readonly ticket: Read;
  readonly pr: Read;
  /** The pull request's commits, oldest committed first. */
  readonly commits: readonly {
    readonly sha: string;
    readonly at: number;
    readonly logins: readonly (string | null)[];
  }[];

  constructor(raw: RawWorkItem) {
    this.raw = raw;
    this.ticket = new Read(raw.ticket, 'ticket');
    this.pr = new Read(raw.pullRequest, 'pullRequest');
    this.commits = this.pr.absent()
      ? []
      : this.pr
          .field('commits')
          .items()
          .map((node) => node.field('commit'))
          .map((commit) => ({
            sha: commit.field('oid').text(),
            at: commit.field('committedDate').time(),
            logins: commit
              .field('authors')
              .field('nodes')
              .items()
              .map((author) =>
                author.field('user').absent()
                  ? null
                  : author.field('user').field('login').optionalText(),
              ),
          }))
          .sort((a, b) => a.at - b.at);
  }

  /** A commit's full sha from its first characters, when the pull request has it. */
  full(sha: string): string {
    return this.commits.find((commit) => commit.sha.startsWith(sha))?.sha ?? sha;
  }

  /** The head before `when`: the latest commit committed before it, as `observe` reads a head. */
  headBefore(when: number): string | null {
    return this.commits.filter((commit) => commit.at < when).at(-1)?.sha ?? null;
  }

  /** The head at `when`: the latest commit committed by then. */
  headAt(when: number): string | null {
    return this.commits.filter((commit) => commit.at <= when).at(-1)?.sha ?? null;
  }
}

const start = (
  raw: Raw,
  executor: RunKind,
  head: string | null,
  attempt: number | null,
  minor = false,
): StartAction => ({
  type: 'start',
  executor,
  item: raw.raw.number,
  head,
  attempt,
  minor,
});

/** The attempt a marker comment's heading names (`CI fix, attempt 1 of 2`), or `null`. */
const attemptIn = (body: string): number | null => {
  const found = /attempt ([0-9]+)/.exec(body)?.[1];

  return found === undefined ? null : Number(found);
};

/** The Executor a factory marker comment ends, and what it was started for. */
function commentAction(raw: Raw, body: string, at: number): StartAction | null {
  const commit = (pattern: RegExp): string | null => {
    const sha = pattern.exec(body)?.[1];

    return sha === undefined ? raw.headBefore(at) : raw.full(sha);
  };

  if (body.startsWith(CI_FIX))
    return start(raw, 'ci-fix', commit(/for commit ([0-9a-f]{7,40})/), attemptIn(body));

  if (body.startsWith(REWORK)) {
    const head = commit(/review of commit ([0-9a-f]{7,40})/);

    return body.includes(REWORK_MINOR)
      ? start(raw, 'rework', head, null, true)
      : start(raw, 'rework', head, attemptIn(body));
  }

  if (body.startsWith(CONFLICT))
    return start(raw, 'conflict', commit(/into commit ([0-9a-f]{7,40})/), attemptIn(body));

  if (body.startsWith(REVIEW_CHANGES))
    return start(raw, 'review', commit(/Re-reviewed ([0-9a-f]{7,40})/), null);

  return null;
}

/** The Ticket's events: its labels, title, description, closing, and the dispatcher's comments. */
function ticketHappenings(raw: Raw, owner: string): Happening[] {
  if (raw.ticket.absent()) return [];

  const happenings: Happening[] = [];
  const timeline = raw.ticket.field('timeline').items();

  const factoryLabeled = (name: string, at: number): boolean =>
    timeline.some(
      (event) =>
        event.field('__typename').text() === 'LabeledEvent' &&
        event.field('label').field('name').optionalText() === name &&
        event.field('actor').field('login').optionalText() !== owner &&
        Math.abs(event.field('createdAt').time() - at) <= 60_000,
    );

  for (const event of timeline) {
    const type = event.field('__typename').text();
    const at = event.field('createdAt').time();
    const actor = event.field('actor').field('login').optionalText();

    const label = event.field('label').absent()
      ? null
      : event.field('label').field('name').optionalText();

    const byOwner = actor === owner;

    if (type === 'LabeledEvent' || type === 'UnlabeledEvent') {
      const added = type === 'LabeledEvent';
      let evidence: Evidence | null = byOwner ? { kind: 'owner' } : null;

      if (!byOwner && added && label === 'building')
        evidence = { kind: 'start', action: start(raw, 'build', null, 1) };

      if (!byOwner && added && label === 'needs-human') evidence = { kind: 'hand-over' };

      if (!byOwner && added && label === 'needs-info')
        evidence = { kind: 'done', action: start(raw, 'build', null, 1), end: true };

      // The build swaps `ready` for `needs-info` when it stops with questions: that isn't a withdrawal.
      if (!byOwner && !added && label === 'ready' && !factoryLabeled('needs-info', at))
        evidence = { kind: 'withdraw' };

      happenings.push({
        at,
        what: `Ticket: \`${label ?? ''}\` ${added ? 'added' : 'removed'} by ${actor ?? 'someone'}`,
        evidence,
      });
    } else if (type === 'RenamedTitleEvent') {
      happenings.push({
        at,
        what: `Ticket: title edited by ${actor ?? 'someone'}`,
        evidence: byOwner ? { kind: 'owner' } : null,
      });
    } else if (type === 'ClosedEvent') {
      // Closed by what merged is the merge's doing; closed by hand is the Owner's.
      const byMerge = !event.field('closer').absent();

      happenings.push({
        at,
        what: 'Ticket: closed',
        evidence: byMerge ? null : { kind: 'owner' },
      });
    } else if (type === 'ReopenedEvent') {
      happenings.push({ at, what: 'Ticket: reopened', evidence: { kind: 'owner' } });
    }
  }

  for (const edit of raw.ticket.field('edits').items()) {
    const editor = edit.field('editor').field('login').optionalText();

    happenings.push({
      at: edit.field('editedAt').time(),
      what: `Ticket: description edited by ${editor ?? 'someone'}`,
      evidence: editor === owner ? { kind: 'owner' } : null,
    });
  }

  const comments = raw.ticket.field('comments');

  for (const comment of comments.absent() ? [] : comments.items()) {
    happenings.push({
      at: comment.field('created_at').time(),
      what: 'Ticket: the dispatcher commented',
      evidence: null,
    });
  }

  return happenings;
}

/** The pull request's events: opened, labels, pushes, checks, comments, mentions, merge. */
function pullRequestHappenings(raw: Raw, owner: string): Happening[] {
  if (raw.pr.absent()) return [];

  const happenings: Happening[] = [];
  const opened = raw.pr.field('createdAt').time();
  const author = raw.pr.field('author').field('login').optionalText();

  happenings.push({
    at: opened,
    what: `pull request #${raw.pr.field('number').number()} opened by ${author ?? 'someone'}`,
    // The implementer opens the factory's pull requests as the end of its build.
    evidence: isHuman(author)
      ? { kind: 'owner' }
      : raw.ticket.absent()
        ? null
        : { kind: 'done', action: start(raw, 'build', null, 1), end: true },
  });

  for (const event of raw.pr.field('timeline').items()) {
    const type = event.field('__typename').text();
    const at = event.field('createdAt').time();
    const actor = event.field('actor').field('login').optionalText();

    const label = event.field('label').absent()
      ? null
      : event.field('label').field('name').optionalText();

    if (type === 'LabeledEvent' || type === 'UnlabeledEvent') {
      const added = type === 'LabeledEvent';
      let evidence: Evidence | null = actor === owner ? { kind: 'owner' } : null;

      if (actor !== owner && added && label === 'needs-human') evidence = { kind: 'hand-over' };

      happenings.push({
        at,
        what: `pull request: \`${label ?? ''}\` ${added ? 'added' : 'removed'} by ${actor ?? 'someone'}`,
        evidence,
      });
    } else if (type === 'MergedEvent') {
      happenings.push({ at, what: 'pull request: merged', evidence: { kind: 'owner' } });
    } else if (type === 'ClosedEvent') {
      happenings.push({ at, what: 'pull request: closed', evidence: null });
    } else if (type === 'ReopenedEvent') {
      happenings.push({ at, what: 'pull request: reopened', evidence: { kind: 'owner' } });
    }
  }

  // Pushes, by when each commit was committed: GitHub doesn't say when a commit was pushed.
  for (const commit of raw.commits) {
    const human = commit.logins.some(isHuman);
    const dependabot = commit.logins.every((login) => login?.startsWith('dependabot') ?? false);

    happenings.push({
      at: commit.at,
      what: `push: ${short(commit.sha)} by ${commit.logins.map((login) => login ?? 'no login').join(', ')}`,
      // A factory commit: whose, the Executor comment that follows it says (below).
      evidence: human
        ? { kind: 'owner' }
        : dependabot
          ? null
          : { kind: 'done', action: null, end: false },
    });
  }

  for (const entry of new Read(raw.raw.checks, 'checks').items()) {
    for (const run of entry.field('checkRuns').items()) {
      const completed = run.field('completed_at').optionalTime();

      if (completed === null) continue;

      happenings.push({
        at: completed,
        what: `check: ${run.field('name').text()} ended ${run.field('conclusion').optionalText() ?? 'without a conclusion'} on ${short(entry.field('sha').text())}`,
        evidence: null,
      });
    }
  }

  for (const comment of new Read(raw.raw.comments, 'comments').items()) {
    const body = comment.field('body').text();
    const at = comment.field('created_at').time();
    const updated = comment.field('updated_at').optionalTime() ?? at;
    const marker = body.split('\n')[0] ?? '';

    if (body.startsWith(REVIEW)) {
      // The comment shows only its latest Review: its footer names the commit of that one.
      const sha = /^<sub>Commit ([0-9a-f]{7,40}),/m.exec(body)?.[1];

      happenings.push({
        at,
        what: `comment: ${marker}`,
        evidence: { kind: 'done', action: start(raw, 'review', raw.headAt(at), null), end: true },
      });

      if (updated !== at) {
        happenings.push({
          at: updated,
          what: `comment: ${marker} edited`,
          evidence: {
            kind: 'done',
            action: start(
              raw,
              'review',
              sha === undefined ? raw.headAt(updated) : raw.full(sha),
              null,
            ),
            end: true,
          },
        });
      }

      continue;
    }

    const action = commentAction(raw, body, at);

    happenings.push({
      at,
      what: `comment: ${marker}`,
      evidence: action === null ? null : { kind: 'done', action, end: true },
    });
  }

  for (const mention of new Read(raw.raw.mentions, 'mentions').items()) {
    if (mention.field('user').field('login').optionalText() !== owner) continue;

    happenings.push({
      at: mention.field('created_at').time(),
      what: MENTIONED,
      evidence: { kind: 'owner' },
    });
  }

  return happenings;
}

/** The `factory` statuses that show a Review or a Rework starting or ending (ADR-0063). Not events. */
function statusHappenings(raw: Raw): Happening[] {
  const happenings: Happening[] = [];

  for (const entry of new Read(raw.raw.statuses, 'statuses').items()) {
    const sha = entry.field('sha').text();

    for (const status of entry.field('statuses').items()) {
      if (status.field('context').text() !== 'factory') continue;

      const at = status.field('created_at').time();
      const description = status.field('description').optionalText() ?? '';
      let evidence: Evidence | null = null;

      if (description.startsWith('Working: reviewing')) {
        evidence = { kind: 'start', action: start(raw, 'review', sha, null) };
      } else if (description.startsWith('Working: reworking')) {
        evidence = { kind: 'start', action: start(raw, 'rework', sha, attemptIn(description)) };
      } else if (description.startsWith('Working: fixing the minor findings')) {
        evidence = { kind: 'start', action: start(raw, 'rework', sha, null, true) };
      } else if (
        description.startsWith('Working: reviewed') ||
        description.startsWith('Done: ready for you') ||
        description.startsWith('Done: changes needed')
      ) {
        // Rework's own end says "Done: ready for you; the minor findings are yours".
        evidence = description.startsWith('Done: ready for you;')
          ? null
          : { kind: 'done', action: start(raw, 'review', sha, null), end: true };
      }

      if (evidence !== null) happenings.push({ at, what: null, evidence });
    }
  }

  return happenings;
}

/** Checks run again on the same commit: the sweeper's rerun, unless the CI fixer's. */
function rerunHappenings(raw: Raw, fixerComments: readonly number[]): Happening[] {
  const happenings: Happening[] = [];

  for (const entry of new Read(raw.raw.checks, 'checks').items()) {
    const sha = entry.field('sha').text();
    const byName = new Map<string, number[]>();

    for (const run of entry.field('checkRuns').items()) {
      const started = run.field('started_at').optionalTime();

      if (started === null) continue;

      const name = run.field('name').text();

      byName.set(name, [...(byName.get(name) ?? []), started]);
    }

    const reruns = [...byName]
      .flatMap(([name, starts]) =>
        starts
          .sort((a, b) => a - b)
          .slice(1)
          .map((at) => ({ name, at })),
      )
      .filter(
        ({ at }) => !fixerComments.some((comment) => Math.abs(comment - at) <= FIXER_RERUN_MS),
      )
      .sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));

    let group: { at: number; names: Set<string> } | null = null;

    const flush = (): void => {
      if (group === null) return;

      happenings.push({
        at: group.at,
        what: null,
        evidence: { kind: 'rerun', head: sha, checks: [...group.names].sort() },
      });
    };

    for (const rerun of reruns) {
      if (group !== null && rerun.at - group.at <= RERUN_GROUP_MS) {
        group.names.add(rerun.name);
      } else {
        flush();
        group = { at: rerun.at, names: new Set([rerun.name]) };
      }
    }

    flush();
  }

  return happenings;
}

/** The deploys that included a merge, and the Blockers' closing: events the Ticket waits on. */
function deployHappenings(raw: Raw): Happening[] {
  const happenings: Happening[] = [];
  const completed = new Map<string, number>();

  for (const deploy of new Read(raw.raw.deploys, 'deploys').items()) {
    const sha = deploy.field('head_sha').text();
    const at = deploy.field('updated_at').time();

    completed.set(sha, Math.min(at, completed.get(sha) ?? at));
  }

  const included = new Map<string, { at: number; deploy: string }>();

  for (const inclusion of new Read(raw.raw.inclusions, 'inclusions').items()) {
    const status = inclusion.field('status').text();

    if (status !== 'ahead' && status !== 'identical') continue;

    const commit = inclusion.field('commit').text();
    const deploy = inclusion.field('deploy').text();
    const at = completed.get(deploy);

    if (at === undefined) continue;

    const previous = included.get(commit);

    if (previous === undefined || at < previous.at) included.set(commit, { at, deploy });
  }

  for (const [commit, { at, deploy }] of included) {
    happenings.push({
      at,
      what: `deploy: ${short(deploy)} includes ${short(commit)}`,
      evidence: null,
    });
  }

  for (const blocker of new Read(raw.raw.blockers, 'blockers').items()) {
    for (const event of blocker.field('timeline').items()) {
      if (event.field('__typename').text() !== 'ClosedEvent') continue;

      happenings.push({
        at: event.field('createdAt').time(),
        what: `Blocker #${blocker.field('number').number()}: closed`,
        evidence: null,
      });
    }
  }

  return happenings;
}

interface NamedRuns {
  readonly runs: NamedRun[];
  readonly happenings: Happening[];
}

/** This Work item's named Executor runs, and the start each shows. */
function namedRuns(raw: Raw): NamedRuns {
  const runs: NamedRun[] = [];
  const happenings: Happening[] = [];
  const builds: number[] = [];

  const items = new Read(raw.raw.runs, 'runs')
    .items()
    .filter(isExecutorRun)
    .map((run) => ({ run, parsed: parseRunName(run.field('display_title').optionalText() ?? '') }))
    .sort((a, b) => a.run.field('created_at').time() - b.run.field('created_at').time());

  for (const { run, parsed } of items) {
    if (parsed === null || parsed.item !== raw.raw.number) continue;

    const from = run.field('created_at').time();

    const to =
      run.field('status').text() === 'completed' ? run.field('updated_at').time() : Infinity;

    runs.push({ name: run.field('display_title').text(), kind: parsed.kind, from, to });

    const head = parsed.sha === null ? null : raw.full(parsed.sha);
    let attempt: number | null = null;

    if (parsed.kind === 'build') {
      builds.push(from);
      attempt = builds.length;
    }

    happenings.push({
      at: from,
      what: null,
      evidence: { kind: 'start', action: start(raw, parsed.kind, head, attempt) },
    });
  }

  return { runs, happenings };
}

/**
 * A `needs-human` the factory added just before an Executor's comment, with nothing between, is
 * that Executor's own (`attempt.sh` labels and then comments): part of its run, not a Hand-over of
 * its own. A factory commit belongs to the Executor whose comment comes next, or to the build before
 * the pull request.
 */
function attribute(raw: Raw, happenings: readonly Happening[]): void {
  const opened = raw.pr.absent() ? Infinity : raw.pr.field('createdAt').time();

  happenings.forEach((happening, index) => {
    const evidence = happening.evidence;

    if (evidence === null) return;

    const later = happenings.slice(index + 1);
    const end = later.find((other) => other.evidence?.kind === 'done' && other.evidence.end);

    if (evidence.kind === 'hand-over' && end?.evidence?.kind === 'done') {
      const between = later.slice(0, later.indexOf(end)).some((other) => other.what !== null);

      if (!between && end.at - happening.at <= OWN_LABEL_MS) {
        happening.evidence = { kind: 'done', action: end.evidence.action, end: false };
      }
    }

    if (evidence.kind === 'done' && evidence.action === null) {
      if (happening.at <= opened && !raw.ticket.absent()) {
        happening.evidence = { kind: 'done', action: start(raw, 'build', null, 1), end: false };
      } else if (end?.evidence?.kind === 'done' && end.evidence.action !== null) {
        happening.evidence = { kind: 'done', action: end.evidence.action, end: false };
      }
    }
  });
}

/** An Executor's end this soon after its last, with no start between, is the same run's (a comment and its status). */
const REPEAT_MS = 10 * 60_000;

/** Drops the evidence of an end that repeats the one before it: one run, not a second. */
function dropRepeats(happenings: readonly Happening[]): void {
  const lastEnd = new Map<RunKind, number>();
  const started = new Set<RunKind>();

  for (const happening of happenings) {
    const evidence = happening.evidence;

    if (evidence?.kind === 'start') started.add(evidence.action.executor);

    if (evidence?.kind !== 'done' || evidence.action === null) continue;

    const executor = evidence.action.executor;

    if (!evidence.end) {
      started.add(executor);
      continue;
    }

    const previous = lastEnd.get(executor);

    if (!started.has(executor) && previous !== undefined && happening.at - previous <= REPEAT_MS) {
      happening.evidence = null;
      continue;
    }

    started.delete(executor);
    lastEnd.set(executor, happening.at);
  }
}

/** When an Executor ran, as far as its start and its end show: between them it was running. */
interface Span {
  readonly executor: RunKind;
  readonly from: number;
  readonly to: number;
}

function spans(happenings: readonly Happening[]): Span[] {
  const found: Span[] = [];
  const lastEnd = new Map<RunKind, number>();

  for (const happening of happenings) {
    const evidence = happening.evidence;

    if (evidence?.kind !== 'done' || !evidence.end || evidence.action === null) continue;

    const executor = evidence.action.executor;
    const after = lastEnd.get(executor) ?? -Infinity;

    const starts = happenings.filter(
      (other) =>
        other.at > after &&
        other.at <= happening.at &&
        other !== happening &&
        ((other.evidence?.kind === 'start' && other.evidence.action.executor === executor) ||
          (other.evidence?.kind === 'done' &&
            !other.evidence.end &&
            other.evidence.action?.executor === executor)),
    );

    const from = starts[0]?.at;

    if (from !== undefined) found.push({ executor, from, to: happening.at });

    lastEnd.set(executor, happening.at);
  }

  return found;
}

const NAMES: Readonly<Record<RunKind, string>> = {
  build: 'build',
  'ci-fix': 'CI fixer',
  review: 'reviewer',
  rework: 'Rework',
  conflict: 'conflict resolver',
  mention: 'mention',
};

/** The Tickets the dispatcher last said were in flight, by `when`. */
function queueAt(raw: Raw, when: number): number[] {
  const comments = raw.ticket.absent() ? null : raw.ticket.field('comments');

  if (comments === null || comments.absent()) return [];

  const latest = comments
    .items()
    .filter((comment) => comment.field('body').text().startsWith(DISPATCH))
    .map((comment) => ({
      at: comment.field('created_at').time(),
      body: comment.field('body').text(),
    }))
    .filter((comment) => comment.at <= when)
    .sort((a, b) => a.at - b.at)
    .at(-1);

  const refs = /, and (#[0-9]+(?:, #[0-9]+)*) (?:is|are) in flight/.exec(latest?.body ?? '')?.[1];

  return refs === undefined ? [] : refs.split(', ').map((ref) => Number(ref.slice(1)));
}

function describe(happening: Happening): string {
  return `${happening.what ?? 'the factory'} at ${iso(happening.at)}`;
}

/** What the factory did after `when`, from the happenings after it. */
function nextAfter(
  when: number,
  happenings: readonly Happening[],
  runs: readonly NamedRun[],
  running: readonly Span[],
): Next {
  const named = runs.find((run) => run.from <= when && when < run.to);

  if (named !== undefined) {
    return {
      action: { type: 'nothing' },
      evidence: `Its run ${named.name} was queued or running then, and decide sees it.`,
    };
  }

  const span = running.find((candidate) => candidate.from <= when && when < candidate.to);

  if (span !== undefined) {
    return {
      unknown: `The ${NAMES[span.executor]} was running then (from ${iso(span.from)} to ${iso(span.to)}), and no Executor run recorded shows it to decide.`,
    };
  }

  const later = happenings.filter((happening) => happening.at > when);
  const first = later.find((happening) => happening.evidence !== null);

  if (first === undefined || first.evidence === null) {
    return {
      action: { type: 'nothing' },
      evidence: 'Nothing the factory or the Owner did followed, by the time it was recorded.',
    };
  }

  const between = later.filter((happening) => happening.at < first.at && happening.what !== null);
  const evidence = first.evidence;

  if (evidence.kind === 'owner') {
    return {
      action: { type: 'nothing' },
      evidence: `The factory did nothing until the Owner acted: ${describe(first)}.`,
    };
  }

  if (evidence.kind === 'done') {
    if (evidence.action === null) {
      return { unknown: `A factory commit (${describe(first)}) no Executor's comment claims.` };
    }

    if (between[0] !== undefined) {
      return {
        unknown: `The ${NAMES[evidence.action.executor]}'s work (${describe(first)}) came after ${describe(between[0])}, and when it started isn't recorded.`,
      };
    }

    return { action: evidence.action, evidence: `Its work: ${describe(first)}.` };
  }

  if (between[0] !== undefined) {
    return {
      action: { type: 'nothing' },
      evidence: `The factory took no step before ${describe(between[0])}.`,
    };
  }

  if (evidence.kind === 'start') {
    return { action: evidence.action, evidence: `It started: ${describe(first)}.` };
  }

  if (evidence.kind === 'rerun') {
    return {
      action: { type: 'rerun', head: evidence.head, checks: evidence.checks },
      evidence: `Checks ran again on ${short(evidence.head)} at ${iso(first.at)}.`,
    };
  }

  const reason = describe(first);

  return evidence.kind === 'hand-over'
    ? { action: { type: 'hand-over', reason }, evidence: reason }
    : { action: { type: 'withdraw', reason }, evidence: reason };
}

/**
 * Every event in the Work item's life, oldest first, each with the step the factory took next.
 * Events at the same moment are one checkpoint.
 */
export function checkpoints(rawItem: RawWorkItem): Checkpoint[] {
  const raw = new Raw(rawItem);
  const owner = rawItem.owner;
  const life = [...ticketHappenings(raw, owner), ...pullRequestHappenings(raw, owner)];

  const fixerComments = life.flatMap((happening) =>
    happening.evidence?.kind === 'done' &&
    happening.evidence.end &&
    happening.evidence.action?.executor === 'ci-fix'
      ? [happening.at]
      : [],
  );

  const named = namedRuns(raw);

  const happenings = [
    ...life,
    ...deployHappenings(raw),
    ...statusHappenings(raw),
    ...rerunHappenings(raw, fixerComments),
    ...named.happenings,
  ]
    // Stable: at one moment, what's an event in its life first, in the order read.
    .map((happening, index) => ({ happening, index }))
    .sort((a, b) => a.happening.at - b.happening.at || a.index - b.index)
    .map(({ happening }) => happening);

  attribute(raw, happenings);
  dropRepeats(happenings);

  const running = spans(happenings);
  const moments = new Map<number, string[]>();

  for (const happening of happenings) {
    if (happening.what === null) continue;

    moments.set(happening.at, [...(moments.get(happening.at) ?? []), happening.what]);
  }

  return [...moments].map(([at, events]) => ({
    at: iso(at),
    events,
    building: queueAt(raw, at).filter((number) => number !== rawItem.number),
    // The mention Executor answers without a marker comment: only its named run shows it, and
    // another Executor's run after the mention isn't its answer.
    next:
      events.includes(MENTIONED) &&
      !named.runs.some((run) => run.kind === 'mention' && run.from >= at)
        ? {
            unknown:
              "The Owner's `@claude` is answered by a mention run, which leaves no comment the recorder can read, and no mention run is recorded after it.",
          }
        : nextAfter(at, happenings, named.runs, running),
  }));
}
