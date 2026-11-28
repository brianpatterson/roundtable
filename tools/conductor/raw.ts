// What `gather` returns for one Work item: GitHub's answers, trimmed to the fields `observe` reads
// (tools/conductor/README.md lists them), and nothing parsed yet. A history fixture is one of these
// saved as JSON, so `observe` reads every part as untrusted.

import type { Json, Read } from './json.ts';

/**
 * The commit a closed event's `closer` put on `main`: a merged pull request's merge commit, or the
 * commit itself. `null` for a pull request closed without merging. `gather` compares these with
 * the deploys and `observe` looks them up, so both read the closer here.
 */
export function closerCommit(closer: Read): string | null {
  if (closer.field('__typename').text() !== 'PullRequest') return closer.field('oid').text();

  return closer.field('merged').boolean() ? closer.field('mergeCommit').field('oid').text() : null;
}

/**
 * Whether a workflow run can be an Executor run: started by `workflow_dispatch`, which only a
 * collaborator can do. A pull request's CI runs carry its title, which anyone can make look like an
 * Executor run's name.
 */
export const isExecutorRun = (run: Read): boolean =>
  run.field('event').optionalText() === 'workflow_dispatch';

/** The open Work items, as `gather` lists them before reading each one. */
export interface WorkItemRef {
  /** The Ticket's number, or the pull request's when there's no Ticket. */
  readonly number: number;
  readonly ticket: number | null;
  readonly pullRequest: number | null;
}

export interface RawWorkItem {
  readonly number: number;
  /** The repository owner's login: the Owner, whose labels count as Approval. */
  readonly owner: string;
  /**
   * The Ticket, or `null`: `{number, createdAt, author: {login}, timeline: [...], edits: [...],
   * comments: [...]}`, where the timeline holds its labeled, unlabeled, renamed, closed and reopened
   * events, edits its description's `userContentEdits`, and comments the dispatcher's
   * (`<!-- factory-dispatch -->`) as `{user, created_at, body}`, cut to the marker and one line.
   */
  readonly ticket: Json;
  /** The Ticket's Blockers: `[{number, createdAt, timeline: [...]}]`, the same events. */
  readonly blockers: Json;
  /**
   * The pull request, or `null`: `{number, createdAt, author, mergeable, mergeCommit, commits,
   * timeline}`, with its commits' authors and its labeled, unlabeled, closed, reopened and merged
   * events.
   */
  readonly pullRequest: Json;
  /** Check runs per commit: `[{sha, checkRuns: [{name, status, conclusion, started_at, completed_at}]}]`. */
  readonly checks: Json;
  /** Commit statuses per commit: `[{sha, statuses: [{context, state, description, created_at}]}]`. */
  readonly statuses: Json;
  /** The factory's marker comments on the pull request: `[{user, created_at, updated_at, body}]`. */
  readonly comments: Json;
  /**
   * The Owner's comments on the pull request that mention `@claude`: `[{user, created_at}]`,
   * without their text.
   */
  readonly mentions: Json;
  /** The latest commits of `main`: `[{sha, committed_at}]`. */
  readonly main: Json;
  /** Successful deploys: `[{head_sha, updated_at}]`. */
  readonly deploys: Json;
  /** Whether a deploy includes a commit: `[{commit, deploy, status}]`, GitHub's compare status. */
  readonly inclusions: Json;
  /**
   * Executor runs, every Work item's, started by `workflow_dispatch`:
   * `[{display_title, event, status, created_at, run_started_at, updated_at}]`.
   */
  readonly runs: Json;
}

/** A Work item GitHub failed or refused to answer about, and why. */
export interface UnreadableWorkItem {
  readonly number: number;
  readonly unreadable: string;
}

export type GatheredWorkItem = RawWorkItem | UnreadableWorkItem;
