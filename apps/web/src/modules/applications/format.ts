import type { ApplicationStatus, InterviewType } from '@roundtable/contract';

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

/** When it was sent, or "Not sent" while it's saved (ADR-0045). */
export const appliedLabel = (appliedAt: Date | null) =>
  appliedAt ? formatDate(appliedAt) : 'Not sent';
