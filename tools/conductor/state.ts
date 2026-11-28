// A Work item's state as it was at one moment: what `observe(raw, at)` builds from `gather`'s raw
// answers, and what `decide` reads. Words are the factory's (docs/factory/GLOSSARY.md).

import type { RunKind } from './run-name.ts';

/**
 * A part of the state that's either known, or `unknown` with what was missing: a field GitHub's
 * answer didn't have, or a fact GitHub only shows as it is now, asked about a past moment.
 */
export type Fact<T> =
  { readonly known: true; readonly value: T } | { readonly known: false; readonly missing: string };

/** The label a Work item waits on the Owner under. */
export type Held = 'needs-human' | 'needs-info';

export interface WorkItemState {
  /** The Ticket's number, or the pull request's when there's no Ticket. */
  readonly number: number;
  /** The moment the state is for, as an ISO timestamp. */
  readonly at: string;
  /** `null` when the Work item has no Ticket, or it wasn't opened yet at `at`. */
  readonly ticket: Fact<TicketState | null>;
  /** `null` when the Work item has no pull request, or it wasn't opened yet at `at`. */
  readonly pullRequest: Fact<PullRequestState | null>;
  readonly runs: Fact<RunsState>;
  /** The head of `main` at `at`: the latest commit of it committed by then. Conflicts count per commit of it. */
  readonly main: Fact<string>;
}

/** How an issue was closed, the last time it was: by a merged change, or without one. */
export interface Closure {
  readonly merged: boolean;
  /** The merge commit, or the commit that closed it; `null` when nothing merged closed it. */
  readonly commit: string | null;
  /** When it was closed. */
  readonly at: string;
  /** Whether a successful deploy that completed by `at` includes `commit`. */
  readonly deployed: Fact<boolean>;
}

export interface TicketState {
  readonly number: number;
  readonly open: boolean;
  /** How it was closed; `null` while it's open. */
  readonly closed: Closure | null;
  /** Its labels at `at`. */
  readonly labels: readonly string[];
  /** Its `ready` label at `at`, and whether it's an Approval; `null` without one. */
  readonly ready: Ready | null;
  /** The label it waits on the Owner under: `needs-info` stops holding it once `answered`. */
  readonly held: Held | null;
  /** Labeled `needs-info`, and since then labeled `ready` again. */
  readonly answered: boolean;
  /** Labeled `building`, and when that label was last added. */
  readonly building: { readonly since: string } | null;
  readonly blockers: Fact<readonly BlockerState[]>;
}

/** The latest `ready` label on a Ticket, read by `dispatch.sh`'s rules (ADR-0047, ADR-0051). */
export interface Ready {
  /** Who added it. */
  readonly by: string;
  readonly at: string;
  /** Whether it's an Approval: the Owner's label, or the nightly run's on a Mutation ticket it opened. */
  readonly approved: boolean;
  /** An Approval by the nightly mutation run, which waits behind the Owner's Tickets (ADR-0052). */
  readonly nightly: boolean;
  /**
   * When the Approval began: the first approving `ready` since the workflow last removed it.
   * Removing and re-adding it themselves doesn't restart it. `null` when it isn't an Approval.
   */
  readonly since: string | null;
  /** Its title or description was edited by anyone but the Owner after the Approval began. */
  readonly voided: boolean;
}

export interface BlockerState {
  readonly number: number;
  readonly status: 'open' | 'merged' | 'unmerged';
  /** Whether its merge commit is Deployed at `at`; `false` while it's open or closed unmerged. */
  readonly deployed: Fact<boolean>;
  readonly held: Held | null;
  readonly labels: readonly string[];
}

export interface PullRequestState {
  readonly number: number;
  readonly author: string;
  readonly status: 'open' | 'merged' | 'closed';
  /** Its merge, once it's merged. */
  readonly merged: {
    readonly at: string;
    readonly commit: string;
    readonly deployed: Fact<boolean>;
  } | null;
  /** Its labels at `at`. */
  readonly labels: readonly string[];
  /** The head commit at `at`: the latest commit committed by then. */
  readonly head: Fact<string>;
  /** When the head was committed: CI that hasn't started long after it never will. */
  readonly headAt: Fact<string>;
  /**
   * Opened by Dependabot, and every commit is Dependabot's: the reviewer skips it (`review.yml`,
   * ADR-0033) until anyone else pushes to it.
   */
  readonly dependabotOnly: boolean;
  /** The Owner's latest comment that mentions `@claude`, in the 24 hours before `at`; `null` without one. */
  readonly mention: Fact<string | null>;
  /** GitHub's `mergeable`, which it only shows as it is now. */
  readonly mergeable: Fact<'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'>;
  /** The check runs on the head at `at`, the latest of each name. */
  readonly checks: Fact<readonly CheckState[]>;
  /** The commit statuses on the head at `at`, the latest of each context. */
  readonly statuses: Fact<readonly CommitStatus[]>;
  readonly attempts: Fact<Attempts>;
  /** The Review of the head at `at`; `null` when there's none. */
  readonly review: Fact<Review | null>;
}

export interface CheckState {
  readonly name: string;
  /** One that completed after `at` was running then. */
  readonly status: 'queued' | 'in_progress' | 'completed';
  /** Set once it's completed. */
  readonly conclusion: string | null;
  readonly startedAt: string;
  /** When it completed; `null` while it runs. */
  readonly completedAt: string | null;
  /** How many runs of this name started on the head by `at`: more than one means it was rerun. */
  readonly runs: number;
}

export interface CommitStatus {
  readonly context: string;
  readonly state: 'error' | 'failure' | 'pending' | 'success';
  readonly description: string;
  readonly at: string;
}

/** The Attempts made by `at`, counted as `attempt.sh` counts them. */
export interface Attempts {
  /** The last commit with a human author, from which CI-fix and Rework Attempts count. */
  readonly since: string | null;
  readonly ciFix: number;
  readonly rework: number;
  /** Rework's Minor passes since `since`, which aren't Attempts. */
  readonly minorPasses: number;
  /** Conflict Attempts, per commit of `main` the resolver merged. */
  readonly conflict: readonly { readonly main: string; readonly count: number }[];
}

export interface Review {
  readonly verdict: 'ready' | 'changes';
  /** The commit reviewed. Only a Review of the head says the pull request is reviewed. */
  readonly commit: string;
  /** When the verdict was given. */
  readonly at: string;
  /** Its minor findings, which Rework's Minor pass fixes (ADR-0053); `null` when it can't be told. */
  readonly minor: number | null;
}

export interface RunsState {
  /** This Work item's Executor runs queued or running at `at`. */
  readonly active: readonly ActiveRun[];
  /** This Work item's Executor runs that had finished by `at`, of those created in the 24 hours before it. */
  readonly finished: readonly FinishedRun[];
  /** Executor runs started in the 24 hours before `at`: this Work item's, and all of them. */
  readonly startedLastDay: { readonly item: number; readonly all: number };
}

export interface ActiveRun {
  readonly name: string;
  readonly kind: RunKind;
  readonly sha: string | null;
  readonly status: 'queued' | 'in_progress';
}

export interface FinishedRun {
  readonly name: string;
  readonly kind: RunKind;
  readonly sha: string | null;
  /** When it was created: a run created after the evidence it answers has taken that step. */
  readonly createdAt: string;
}
