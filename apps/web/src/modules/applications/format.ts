import {
  dayOf,
  inRoundOrder,
  isTimeZone,
  roundDay,
  type ApplicationStatus,
  type InterviewType,
  type OrderedRound,
  type Round,
} from '@roundtable/contract';

/**
 * The user's time zone, as the browser reports it, for a request the API infers Outcomes from
 * (ADR-0061). Nothing when the browser reports one the API wouldn't accept: the API then uses UTC.
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

/**
 * The Rounds in Round order in the user's time zone (ADR-0054), from the contract. The server
 * orders a due day by midnight UTC, as it doesn't know the user's zone, which puts a take-home
 * ahead of an interview the evening before for anyone west of UTC.
 */
export const inLocalOrder = (rounds: readonly Round[]): Round[] =>
  inRoundOrder(rounds, new Intl.DateTimeFormat().resolvedOptions().timeZone);

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

// The Agenda (ADR-0070): which day a Round is on and how long is left, at `now` in the user's
// `timeZone`. Days are calendar days there, not 24-hour periods, so a Round at 9:00 tomorrow is
// "Tomorrow" at 23:00 today.

/** The browser's time zone: the user's. */
export const userTimeZone = () => new Intl.DateTimeFormat().resolvedOptions().timeZone;

const MS_PER_DAY = 86_400_000;

const MINUTES_PER_HOUR = 60;

/** `2026-12-01` → midnight UTC that day, so two days subtract to whole days. */
const utcDay = (date: string) => {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);

  return Date.UTC(year, month - 1, day);
};

/** How many calendar days `day` is after today, in `timeZone`: 0 today, 1 tomorrow, −1 yesterday. */
const daysFromToday = (day: string, now: Date, timeZone: string) =>
  Math.round((utcDay(day) - utcDay(dayOf(now, timeZone))) / MS_PER_DAY);

const fullDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeZone: 'UTC' });

/**
 * The heading of a day on the Agenda: "Today", "Tomorrow", or the date (`Friday, December 4,
 * 2026`). Null, for Rounds not scheduled yet, is "Not scheduled yet".
 */
export function dayHeading(day: string | null, now: Date, timeZone: string) {
  if (day === null) return 'Not scheduled yet';

  const days = daysFromToday(day, now, timeZone);

  if (days === 0) return 'Today';

  if (days === 1) return 'Tomorrow';

  return fullDate.format(utcDay(day));
}

/** In `days` calendar days: "today", "tomorrow", "in 3 days". */
const inDays = (days: number) => {
  if (days === 0) return 'today';

  return days === 1 ? 'tomorrow' : `in ${days} days`;
};

/** `135` → "2 h 15 min", `40` → "40 min", `120` → "2 h". */
const hoursAndMinutes = (minutes: number) => {
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  const rest = minutes % MINUTES_PER_HOUR;

  if (hours === 0) return `${rest} min`;

  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
};

/**
 * How long is left until a Round at `now`: "in 2 h 15 min" later today, "Started" once it has,
 * "Tomorrow" or "in 3 days" on a later day, and "Due today", "Due tomorrow" or "Due in 3 days" for
 * a take-home. Null for one not scheduled yet. A take-home whose day has passed (the page was left
 * open overnight) is "Past due".
 */
export function timeLeft({ startsAt, dueOn }: OrderedRound, now: Date, timeZone: string) {
  if (dueOn !== null) {
    const days = daysFromToday(dueOn, now, timeZone);

    return days < 0 ? 'Past due' : `Due ${inDays(days)}`;
  }

  if (startsAt === null) return null;

  const days = daysFromToday(dayOf(startsAt, timeZone), now, timeZone);

  if (days === 1) return 'Tomorrow';

  if (days > 1) return inDays(days);

  const minutes = Math.ceil((startsAt.getTime() - now.getTime()) / MS_PER_MINUTE);

  return days < 0 || minutes <= 0 ? 'Started' : `in ${hoursAndMinutes(minutes)}`;
}

const timeOfDay = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

/** The time a Round starts in the user's time zone, "Due" for a take-home, null if unscheduled. */
export function agendaTime({ startsAt, dueOn }: OrderedRound) {
  if (startsAt) return timeOfDay.format(startsAt);

  return dueOn === null ? null : 'Due';
}

/** Rounds of one day on the Agenda, or of none (`day` null) for those not scheduled yet. */
export interface AgendaDay<R> {
  readonly day: string | null;
  readonly rounds: readonly R[];
}

/**
 * The Agenda's Rounds grouped by their day in `timeZone`, keeping the order given (the API's): a
 * new group starts each time the day changes, so a day only appears once when they're in order.
 */
export function byDay<R extends OrderedRound>(
  rounds: readonly R[],
  timeZone: string,
): AgendaDay<R>[] {
  const days: { day: string | null; rounds: R[] }[] = [];

  for (const round of rounds) {
    const day = roundDay(round, timeZone);
    const last = days.at(-1);

    if (last?.day === day) last.rounds.push(round);
    else days.push({ day, rounds: [round] });
  }

  return days;
}
