// Executor run names (ADR-0076): `<kind> #<item> <sha7>`. The Conductor reads them to see what is
// queued or running for each Work item and to count the dispatch budget, and each Executor names
// its run the same way, so both sides use these two functions.

export const RUN_KINDS = ['build', 'ci-fix', 'review', 'rework', 'conflict', 'mention'] as const;

export type RunKind = (typeof RUN_KINDS)[number];

export interface RunName {
  readonly kind: RunKind;
  /** The Work item's number: the Ticket's, or the pull request's when there's no Ticket. */
  readonly item: number;
  /** The first 7 characters of the head commit it was started for, or `null` before there is one. */
  readonly sha: string | null;
}

const pattern = /^(build|ci-fix|review|rework|conflict|mention) #([1-9][0-9]*) ([0-9a-f]{7}|-)$/;

const isKind = (text: string): text is RunKind => RUN_KINDS.some((kind) => kind === text);

/** The run name for one Executor run. */
export function makeRunName(run: RunName): string {
  return `${run.kind} #${run.item} ${run.sha === null ? '-' : run.sha.slice(0, 7)}`;
}

/** The Executor run a name stands for, or `null` when it isn't one. */
export function parseRunName(name: string): RunName | null {
  const match = pattern.exec(name);

  if (match === null) return null;

  const [, kind = '', item = '', sha = ''] = match;

  if (!isKind(kind)) return null;

  return { kind, item: Number(item), sha: sha === '-' ? null : sha };
}
