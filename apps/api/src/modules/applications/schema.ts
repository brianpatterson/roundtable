import { index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { STORED_APPLICATION_STATUSES } from '@roundtable/contract';
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
