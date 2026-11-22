import { index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { INTERVIEW_TYPES, STORED_APPLICATION_STATUSES } from '@roundtable/contract';
import { timestamps } from '../../platform/database/columns.js';
import { users } from '../identity/index.js';

export const applicationStatus = pgEnum('application_status', STORED_APPLICATION_STATUSES);

// The foreign key to users is the one place this module reaches into identity's tables. It goes
// if applications ever gets its own database (ADR-0023).
export const applications = pgTable(
  'applications',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    company: text().notNull(),
    jobTitle: text('job_title').notNull(),
    jobUrl: text('job_url'),
    status: applicationStatus().notNull().default('applied'),
    // When it was sent; null while saved (ADR-0045). Postgres's clock, like the timestamps. The
    // default covers the release before this column, whose inserts are always sent applications.
    appliedAt: timestamp('applied_at', { withTimezone: true }).defaultNow(),
    ...timestamps,
  },
  // Every query filters by user and sorts by most recently updated.
  (t) => [index('applications_user_id_updated_at_idx').on(t.userId, t.updatedAt.desc())],
);

export const interviewType = pgEnum('interview_type', INTERVIEW_TYPES);

// An application owns its Rounds: they go when it does. Whose they are is the application's
// user_id, so every query reaches them through an application the user owns.
export const rounds = pgTable(
  'rounds',
  {
    id: uuid().primaryKey().defaultRandom(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    interviewType: interviewType('interview_type').notNull(),
    ...timestamps,
  },
  // Every query reads one application's Rounds in the order they were added.
  (t) => [index('rounds_application_id_created_at_idx').on(t.applicationId, t.createdAt)],
);
