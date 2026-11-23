import {
  isTimeZone,
  type ApplicationStatus,
  type InterviewType,
  type Round,
} from '@roundtable/contract';

/**
 * The user's time zone, as the browser reports it, for a request the API infers Outcomes from
 * (ADR-0060). Nothing when the browser reports one the API wouldn't accept: the API then uses UTC.
 */
export function inUserTimeZone(): { timeZone?: string } {
  const { timeZone } = new Intl.DateTimeFormat().resolvedOptions();

  return isTimeZone(timeZone) ? { timeZone } : {};
}

// How the table and an application's page show an application's fields.

const interviewTypeLabels: Record<InterviewType, string> = {
  recruiter_screen: 'Recruiter screen',
  hiring_manager: 'Hiring manager',
  coding: 'Coding',
  system_design: 'System design',
  behavioral: 'Behavioral',
  take_home: 'Take-home',
  presentation: 'Presentation',
  other: 'Other',
};

/** `system_design` → `System design`. */
export const interviewTypeLabel = (type: InterviewType) => interviewTypeLabels[type];

export const formatDate = (date: Date) => date.toLocaleDateString();

/** `interviewing` → `Interviewing`. */
export const statusLabel = (status: ApplicationStatus) =>
  status.charAt(0).toUpperCase() + status.slice(1);

// In the browser's locale and time zone (the user's own).
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const calendarDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

const MS_PER_MINUTE = 60_000;

/** `2026-12-01` → the start of that day in the user's time zone. */
const localDay = (date: string) => {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);

  return new Date(year, month - 1, day);
};

/**
 * `2026-12-01` → `Dec 1, 2026`. A due date is a calendar day, not an instant: it's read as that
 * day wherever the user is, never shifted by their time zone.
 */
const formatCalendarDate = (date: string) => calendarDate.format(localDay(date));

/** When a Round sorts: its start, or the start of its due day in the user's zone; else none. */
const sortTime = ({ startsAt, dueOn }: Round) =>
  startsAt?.getTime() ?? (dueOn === null ? null : localDay(dueOn).getTime());

/**
 * The Rounds in date order in the user's time zone (ADR-0054): dated ones first, a take-home at
 * the start of its due day, then the rest in the order given. The server orders a due day by
 * midnight UTC, as it doesn't know the user's zone, which puts a take-home ahead of an interview
 * the evening before for anyone west of UTC.
 */
export const inLocalOrder = (rounds: readonly Round[]): Round[] =>
  [...rounds].sort((a, b) => {
    const [x, y] = [sortTime(a), sortTime(b)];

    if (x === null || y === null) return (x === null ? 1 : 0) - (y === null ? 1 : 0);

    return x - y;
  });

/**
 * When a Round happens or is due: its start (to its end, when it has a duration) in the user's
 * time zone, "Due" and its date, or "Not scheduled yet".
 */
export function scheduleLabel({ startsAt, durationMinutes, dueOn }: Round) {
  if (startsAt) {
    if (durationMinutes === null) return dateTime.format(startsAt);

    return dateTime.formatRange(
      startsAt,
      new Date(startsAt.getTime() + durationMinutes * MS_PER_MINUTE),
    );
  }

  return dueOn ? `Due ${formatCalendarDate(dueOn)}` : 'Not scheduled yet';
}

/**
 * Each Round's name, in the order given: its type and which of that type it is, `Coding 2`. A
 * name follows the list's order, so rescheduling a Round can rename the others of its type.
 */
export const roundNames = (rounds: readonly Round[]) => {
  const counts = new Map<InterviewType, number>();

  return rounds.map(({ interviewType }) => {
    const count = (counts.get(interviewType) ?? 0) + 1;

    counts.set(interviewType, count);

    return `${interviewTypeLabel(interviewType)} ${count}`;
  });
};

/** When it was sent, or "Not sent" while it's saved (ADR-0045). */
export const appliedLabel = (appliedAt: Date | null) =>
  appliedAt ? formatDate(appliedAt) : 'Not sent';
