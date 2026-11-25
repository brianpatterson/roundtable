import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { MAX_SKILL_NAME } from '@roundtable/contract';
import { timestamps } from '../../platform/database/columns.js';
import { users } from '../identity/index.js';

/**
 * What makes two Skill names the same one: their lower case. The contract trims them first. The
 * unique index is built on it, and a query looking for the Skill a name collides with uses the
 * same expression, so names are compared in one way only.
 */
export const skillNameKey = (name: SQL | AnyColumn) => sql`lower(${name})`;

// The skill library (GLOSSARY.md): the Skills a user practices. Archived, never deleted: prep
// tasks refer to them by id (ADR-0044 rule 3). They go with the account, through the foreign key
// to users (ADR-0044 rule 2).
export const skills = pgTable(
  'skills',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    // When it was archived; null while active. Restoring clears it.
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // One Skill per name per user, ignoring case. Every query filters by user, so it serves the
    // list and the count too.
    uniqueIndex('skills_user_id_name_key').on(t.userId, skillNameKey(t.name)),
    check(
      'skills_name_check',
      sql`char_length(${t.name}) between 1 and ${sql.raw(String(MAX_SKILL_NAME))}`,
    ),
  ],
);
