import type { ApplicationStatus } from '@roundtable/contract';

// How the table and an application's page show an application's fields.

export const formatDate = (date: Date) => date.toLocaleDateString();

/** `interviewing` → `Interviewing`. */
export const statusLabel = (status: ApplicationStatus) =>
  status.charAt(0).toUpperCase() + status.slice(1);

/** When it was sent, or "Not sent" while it's saved (ADR-0045). */
export const appliedLabel = (appliedAt: Date | null) =>
  appliedAt ? formatDate(appliedAt) : 'Not sent';
