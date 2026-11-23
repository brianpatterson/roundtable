// Inferred Outcomes (GLOSSARY.md, ADR-0061): adding a Round passes the pending Rounds before it,
// and a rejection fails the latest pending ones. Pure, so they're tested without a database; the
// Round lifecycle (./round-lifecycle.ts) runs them inside the transaction that makes the change,
// on the Rounds it reads there. The order and the user's day come from the contract's Round order.
import { inRoundOrder, roundDay } from '@roundtable/contract';

/** What inference reads of a Round. */
export interface InferenceRound {
  readonly id: string;
  readonly startsAt: Date | null;
  readonly dueOn: string | null;
  readonly outcome: string;
  readonly outcomeSetByUser: boolean;
}

/**
 * The Rounds inference may change: pending, and the user hasn't set its Outcome (ADR-0059). The
 * one definition: the rules below test it, and the Round lifecycle's SQL guard writes it.
 */
export const INFERABLE = { outcome: 'pending', outcomeSetByUser: false } as const;

const inferable = (round: InferenceRound) =>
  round.outcome === INFERABLE.outcome && round.outcomeSetByUser === INFERABLE.outcomeSetByUser;

/**
 * The Rounds adding `added` passes: every inferable one of `earlier` that comes before it in
 * Round order, or on the same date. One not scheduled counts as before, wherever the list shows
 * it.
 */
export function passedByNewRound(
  earlier: readonly InferenceRound[],
  added: InferenceRound,
  timeZone: string,
): string[] {
  const scheduled = (round: InferenceRound) => roundDay(round, timeZone) !== null;

  // `added` goes last, so an earlier Round with the same date stays ahead of it.
  const inOrder = inRoundOrder([...earlier, added], timeZone);
  const before = new Set(inOrder.slice(0, inOrder.indexOf(added)));

  const comesBefore = (round: InferenceRound) =>
    !scheduled(added) || !scheduled(round) || before.has(round);

  return earlier.flatMap((round) => (inferable(round) && comesBefore(round) ? [round.id] : []));
}

/**
 * The Rounds a rejection fails: the latest inferable one in Round order and, when it's dated,
 * every inferable one on the same calendar day in the user's time zone. `rounds` must come in the
 * order they were added (Postgres's `created_at, id`, as the list breaks ties): a `Date` keeps
 * only milliseconds, so two Rounds added in the same one can't be told apart here, and Round
 * order keeps them as given.
 */
export function failedByRejection(rounds: readonly InferenceRound[], timeZone: string): string[] {
  const pending = inRoundOrder(rounds.filter(inferable), timeZone);
  const latest = pending.at(-1);

  if (!latest) return [];

  const latestDay = roundDay(latest, timeZone);

  if (latestDay === null) return [latest.id];

  return pending.flatMap((round) => (roundDay(round, timeZone) === latestDay ? [round.id] : []));
}
