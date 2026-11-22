import type { ApplicationStatus, InterviewType, Round } from '@roundtable/contract';

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

/**
 * `2026-12-01` → `Dec 1, 2026`. A due date is a calendar day, not an instant: it's read as that
 * day wherever the user is, never shifted by their time zone.
 */
const formatCalendarDate = (date: string) => {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);

  return calendarDate.format(new Date(year, month - 1, day));
};

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

/** When it was sent, or "Not sent" while it's saved (ADR-0045). */
export const appliedLabel = (appliedAt: Date | null) =>
  appliedAt ? formatDate(appliedAt) : 'Not sent';
