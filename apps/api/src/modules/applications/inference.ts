// Inferred Outcomes (GLOSSARY.md, ADR-0061): adding a Round passes the pending Rounds before it,
// and a rejection fails the latest pending ones. Pure, so the handlers run it inside the
// transaction that makes the change, on the Rounds they read there.

/** What inference reads of a Round. */
export interface InferenceRound {
  readonly id: string;
  readonly startsAt: Date | null;
  readonly dueOn: string | null;
  readonly outcome: string;
  readonly outcomeSetByUser: boolean;
}

/** A Round inference may change: pending, and the user hasn't set its Outcome (ADR-0059). */
const inferable = (round: InferenceRound) => round.outcome === 'pending' && !round.outcomeSetByUser;

/** The calendar date and time an instant reads as in `timeZone`, as numbers. */
function zonedParts(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(instant);

  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);

  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour: part('hour'),
    minute: part('minute'),
    second: part('second'),
  };
}

/** How far `timeZone` is ahead of UTC at `instant`, in milliseconds. */
function offsetAt(instant: number, timeZone: string) {
  const { year, month, day, hour, minute, second } = zonedParts(instant, timeZone);
  const wallClock = Date.UTC(year, month - 1, day, hour, minute, second);

  return wallClock - (instant - (instant % 1000));
}

/** `2026-12-01` → the instant that day starts in `timeZone`. */
function startOfDay(date: string, timeZone: string) {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  const midnightUtc = Date.UTC(year, month - 1, day);
  const guess = midnightUtc - offsetAt(midnightUtc, timeZone);

  // Again at the guess, in case an offset change falls between the two instants.
  return midnightUtc - offsetAt(guess, timeZone);
}

/** The calendar day an instant falls on in `timeZone`, `YYYY-MM-DD`. */
function dayOf(instant: Date, timeZone: string) {
  const { year, month, day } = zonedParts(instant.getTime(), timeZone);

  return [year, month, day].map((n, i) => String(n).padStart(i === 0 ? 4 : 2, '0')).join('-');
}

/**
 * When a Round sorts in the list (ADR-0054): its start, or the start of its due day in the user's
 * time zone; none if it isn't scheduled.
 */
const sortTime = (round: InferenceRound, timeZone: string) =>
  round.startsAt?.getTime() ?? (round.dueOn === null ? null : startOfDay(round.dueOn, timeZone));

/**
 * The Rounds in the list's order: dated ones by date, then the rest as they were added. `rounds`
 * must come in the order they were added (Postgres's `created_at, id`, as the list breaks ties): a
 * `Date` keeps only milliseconds, so two Rounds added in the same one can't be told apart here,
 * and the stable sort keeps them as given.
 */
function inListOrder(rounds: readonly InferenceRound[], timeZone: string) {
  const unscheduledLast = (time: number | null) => time ?? Number.MAX_SAFE_INTEGER;

  return rounds
    .map((round) => ({ round, time: sortTime(round, timeZone) }))
    .toSorted((a, b) => unscheduledLast(a.time) - unscheduledLast(b.time));
}

/**
 * The Rounds adding `added` passes: every inferable one of `earlier` that comes before it in the
 * list's date order. One not scheduled counts as before, wherever the list shows it.
 */
export function passedByNewRound(
  earlier: readonly InferenceRound[],
  added: InferenceRound,
  timeZone: string,
): string[] {
  const addedTime = sortTime(added, timeZone);

  const comesBefore = (round: InferenceRound) => {
    const time = sortTime(round, timeZone);

    return time === null || addedTime === null || time <= addedTime;
  };

  return earlier.flatMap((round) => (inferable(round) && comesBefore(round) ? [round.id] : []));
}

/**
 * The Rounds a rejection fails: the latest inferable one in the list's order and, when it's dated,
 * every inferable one on the same calendar day in the user's time zone. `rounds` come in the order
 * they were added.
 */
export function failedByRejection(rounds: readonly InferenceRound[], timeZone: string): string[] {
  const pending = inListOrder(rounds.filter(inferable), timeZone);
  const latest = pending.at(-1);

  if (!latest) return [];

  if (latest.time === null) return [latest.round.id];

  const day = (round: InferenceRound) =>
    round.dueOn ?? (round.startsAt ? dayOf(round.startsAt, timeZone) : null);

  const latestDay = day(latest.round);

  return pending.flatMap(({ round }) => (day(round) === latestDay ? [round.id] : []));
}
