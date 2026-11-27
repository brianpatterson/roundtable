// What `gather` returns for one Work item: GitHub's answers, trimmed to the fields `observe` reads
// (tools/conductor/README.md lists them), and nothing parsed yet. A history fixture is one of these
// saved as JSON, so `observe` reads every part as untrusted.

import type { Json } from './json.ts';

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
   * The Ticket, or `null`: `{number, createdAt, author: {login}, timeline: [...], edits: [...]}`,
   * where the timeline holds its labeled, unlabeled, renamed, closed and reopened events, and edits
   * its description's `userContentEdits`.
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
  /** Successful deploys: `[{head_sha, updated_at}]`. */
  readonly deploys: Json;
  /** Whether a deploy includes a commit: `[{commit, deploy, status}]`, GitHub's compare status. */
  readonly inclusions: Json;
  /** Executor runs, every Work item's: `[{display_title, status, created_at, run_started_at, updated_at}]`. */
  readonly runs: Json;
}

/** A Work item GitHub failed or refused to answer about, and why. */
export interface UnreadableWorkItem {
  readonly number: number;
  readonly unreadable: string;
}

export type GatheredWorkItem = RawWorkItem | UnreadableWorkItem;
