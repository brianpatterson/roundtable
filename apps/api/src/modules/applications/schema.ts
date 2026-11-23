import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  INTERVIEW_TYPES,
  MAX_RATING_NOTE,
  ROUND_DURATION_MINUTES,
  SELF_RATING,
  STORED_APPLICATION_STATUSES,
} from '@roundtable/contract';
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

// Literal numbers in the constraint's SQL, from the contract's bounds (a parameter can't go in DDL).
const durationRange = sql.raw(
  `${ROUND_DURATION_MINUTES.minimum} and ${ROUND_DURATION_MINUTES.maximum}`,
);

const ratingRange = sql.raw(`${SELF_RATING.minimum} and ${SELF_RATING.maximum}`);

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
    // Its Tags (GLOSSARY.md), in the order they were added: trimmed, at most 10, and none the same
    // as another ignoring case. The handlers keep those rules (ADR-0055). Defaulted, so the release
    // before it still inserts Rounds.
    tags: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // Its schedule (GLOSSARY.md): a start, with a duration when the company gave one; a due date
    // (a take-home); or neither yet. The contract checks the same rules before a handler runs.
    startsAt: timestamp('starts_at', { withTimezone: true }),
    durationMinutes: integer('duration_minutes'),
    dueOn: date('due_on', { mode: 'string' }),
    // The user's Self-rating (GLOSSARY.md): 1 to 5 and a note on what went wrong, each optional.
    selfRating: smallint('self_rating'),
    ratingNote: text('rating_note'),
    ...timestamps,
  },
  (t) => [
    // Every query reads one application's Rounds; there are few, so they're sorted in memory.
    index('rounds_application_id_created_at_idx').on(t.applicationId, t.createdAt),
    check('rounds_start_or_due_check', sql`${t.startsAt} is null or ${t.dueOn} is null`),
    check(
      'rounds_duration_check',
      sql`${t.durationMinutes} is null or (${t.startsAt} is not null and ${t.durationMinutes} between ${durationRange})`,
    ),
    check('rounds_self_rating_check', sql`${t.selfRating} between ${ratingRange}`),
    check(
      'rounds_rating_note_check',
      sql`char_length(${t.ratingNote}) <= ${sql.raw(String(MAX_RATING_NOTE))}`,
    ),
  ],
);
