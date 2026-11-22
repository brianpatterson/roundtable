import { ROUND_DURATION_MINUTES, type Round, type RoundSchedule } from '@roundtable/contract';
import { Select, TextField } from '../../design-system';
import styles from './Schedule.module.css';

// A Round's schedule as a form edits it (GLOSSARY.md): at a time, due by a date, or not yet. The
// inputs hold what the browser's date and time fields give, in the user's own time zone.

export type ScheduleKind = 'none' | 'time' | 'due';

export interface ScheduleDraft {
  readonly kind: ScheduleKind;
  /** `2026-11-25T10:00`, local time: a `datetime-local` input's value. */
  readonly startsAt: string;
  /** Whole minutes as typed, or empty. */
  readonly durationMinutes: string;
  /** `2026-11-25`: a `date` input's value. */
  readonly dueOn: string;
}

export const EMPTY_SCHEDULE: ScheduleDraft = {
  kind: 'none',
  startsAt: '',
  durationMinutes: '',
  dueOn: '',
};

const kindOptions = [
  { value: 'none', label: 'Not scheduled yet' },
  { value: 'time', label: 'At a time' },
  { value: 'due', label: 'Due by a date' },
] as const satisfies readonly { value: ScheduleKind; label: string }[];

const twoDigits = (n: number) => String(n).padStart(2, '0');

/** An instant as a `datetime-local` input shows it: the user's local date and time. */
const toLocalInput = (date: Date) =>
  `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}` +
  `T${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;

/** A Round's schedule, ready to edit. */
export function draftOf(round: Round): ScheduleDraft {
  if (round.startsAt) {
    return {
      ...EMPTY_SCHEDULE,
      kind: 'time',
      startsAt: toLocalInput(round.startsAt),
      durationMinutes: round.durationMinutes === null ? '' : String(round.durationMinutes),
    };
  }

  if (round.dueOn) return { ...EMPTY_SCHEDULE, kind: 'due', dueOn: round.dueOn };

  return EMPTY_SCHEDULE;
}

export type ScheduleResult =
  | { readonly ok: true; readonly schedule: RoundSchedule }
  | { readonly ok: false; readonly error: string };

const { minimum, maximum } = ROUND_DURATION_MINUTES;

/**
 * What a draft asks the API for, or why it can't yet. Only the chosen kind's fields are sent, so
 * a start and a due date never go together.
 */
export function scheduleOf(draft: ScheduleDraft): ScheduleResult {
  if (draft.kind === 'due') {
    return draft.dueOn
      ? { ok: true, schedule: { dueOn: draft.dueOn } }
      : { ok: false, error: 'Enter the date it’s due.' };
  }

  if (draft.kind === 'none') return { ok: true, schedule: {} };

  // A `datetime-local` value has no offset, so `Date` reads it as the browser's local time.
  const startsAt = new Date(draft.startsAt);

  if (!draft.startsAt || Number.isNaN(startsAt.getTime())) {
    return { ok: false, error: 'Enter the date and time it starts.' };
  }

  if (!draft.durationMinutes) return { ok: true, schedule: { startsAt } };

  const durationMinutes = Number(draft.durationMinutes);

  if (
    !Number.isInteger(durationMinutes) ||
    durationMinutes < minimum ||
    durationMinutes > maximum
  ) {
    return {
      ok: false,
      error: `The duration is a whole number of minutes, from ${minimum} to ${maximum}.`,
    };
  }

  return { ok: true, schedule: { startsAt, durationMinutes } };
}

/**
 * The schedule's inputs: which kind, then that kind's fields. They carry no `required`, `min` or
 * `max`: `scheduleOf` checks them and says what's wrong in words, where the browser would stop
 * the form with its own bubble.
 */
export function ScheduleFields({
  draft,
  onChange,
}: {
  draft: ScheduleDraft;
  onChange: (draft: ScheduleDraft) => void;
}) {
  return (
    <div className={styles.fields}>
      <Select
        label="When"
        options={kindOptions}
        value={draft.kind}
        onValueChange={(kind) => onChange({ ...draft, kind })}
      />
      {draft.kind === 'time' && (
        <>
          <TextField
            label="Starts"
            type="datetime-local"
            value={draft.startsAt}
            onChange={(e) => onChange({ ...draft, startsAt: e.target.value })}
          />
          <TextField
            label="Duration (minutes)"
            description="Optional"
            type="number"
            value={draft.durationMinutes}
            onChange={(e) => onChange({ ...draft, durationMinutes: e.target.value })}
          />
        </>
      )}
      {draft.kind === 'due' && (
        <TextField
          label="Due date"
          type="date"
          value={draft.dueOn}
          onChange={(e) => onChange({ ...draft, dueOn: e.target.value })}
        />
      )}
    </div>
  );
}
