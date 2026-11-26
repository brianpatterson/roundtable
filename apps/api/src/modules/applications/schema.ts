import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  APPLICATION_STATUSES,
  INTERVIEW_TYPES,
  MAX_PREP_NOTES,
  MAX_PREP_TASK_TITLE,
  MAX_RATING_NOTE,
  OUTCOMES,
  ROUND_DURATION_MINUTES,
  SELF_RATING,
} from '@roundtable/contract';
import { timestamps } from '../../platform/database/columns.js';
import { users } from '../identity/index.js';

export const applicationStatus = pgEnum('application_status', APPLICATION_STATUSES);

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
    // The Persona (GLOSSARY.md) it's made as, or null for none: one of the personas module's, a
    // plain id with no foreign key (ADR-0044 rule 1), checked through personas' `Personas.findOwned`
    // before it's stored. Personas are archived, never deleted. Nullable, so the release before it
    // still inserts.
    personaId: uuid('persona_id'),
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

export const roundOutcome = pgEnum('round_outcome', OUTCOMES);

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
    // Its Outcome (GLOSSARY.md), and whether the user set it: one they set is never replaced by
    // an inferred one (ADR-0059). Defaulted, so existing Rounds and the release before them read
    // and insert pending, not set by the user.
    outcome: roundOutcome().notNull().default('pending'),
    outcomeSetByUser: boolean('outcome_set_by_user').notNull().default(false),
    // Its Prep notes (GLOSSARY.md): what the user wrote before it. Null when there are none.
    prepNotes: text('prep_notes'),
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
    check(
      'rounds_prep_notes_check',
      sql`char_length(${t.prepNotes}) <= ${sql.raw(String(MAX_PREP_NOTES))}`,
    ),
  ],
);

// A Round's prep tasks (GLOSSARY.md, Prep): they go when it does, and with it its application.
// Whose they are is the application's user_id, reached through the Round. `skill_id` names one of
// the personas module's Skills: a plain id, no foreign key (ADR-0044 rule 1), checked through
// personas' `Skills.findOwned` before it's stored. Skills are archived, never deleted.
export const prepTasks = pgTable(
  'prep_tasks',
  {
    id: uuid().primaryKey().defaultRandom(),
    roundId: uuid('round_id')
      .notNull()
      .references(() => rounds.id, { onDelete: 'cascade' }),
    title: text().notNull(),
    skillId: uuid('skill_id'),
    // Its place among the Round's tasks: one more than the last when it's added, so they list in
    // the order they were added even when two land in the same instant.
    position: integer().notNull(),
    // When it was done; null while it isn't. Postgres's clock, like the timestamps.
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // Every query reads the tasks of a Round, or of a few, in order.
    uniqueIndex('prep_tasks_round_id_position_key').on(t.roundId, t.position),
    check(
      'prep_tasks_title_check',
      sql`char_length(${t.title}) between 1 and ${sql.raw(String(MAX_PREP_TASK_TITLE))}`,
    ),
  ],
);
