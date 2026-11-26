import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { MAX_PERSONA_NAME, MAX_SKILL_NAME } from '@roundtable/contract';
import { timestamps } from '../../platform/database/columns.js';
import { users } from '../identity/index.js';

/**
 * What makes two names the same one, for Skills and Personas alike: their lower case. The contract
 * trims them first. The unique indexes are built on it, and a query looking for the row a name
 * collides with uses the same expression, so names are compared in one way only.
 */
export const nameKey = (name: SQL | AnyColumn) => sql`lower(${name})`;

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
    uniqueIndex('skills_user_id_name_key').on(t.userId, nameKey(t.name)),
    check(
      'skills_name_check',
      sql`char_length(${t.name}) between 1 and ${sql.raw(String(MAX_SKILL_NAME))}`,
    ),
  ],
);

// Personas (GLOSSARY.md): the kinds of candidate a user applies as. Shaped like skills: archived,
// never deleted, since Applications refer to them by id (ADR-0044 rule 3), and gone with the
// account through the foreign key to users (ADR-0044 rule 2).
export const personas = pgTable(
  'personas',
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
    // One Persona per name per user, ignoring case; it serves the list and the count too.
    uniqueIndex('personas_user_id_name_key').on(t.userId, nameKey(t.name)),
    check(
      'personas_name_check',
      sql`char_length(${t.name}) between 1 and ${sql.raw(String(MAX_PERSONA_NAME))}`,
    ),
  ],
);

// The Skills each Persona needs. Both sides are this module's, so both are real foreign keys, and
// a Persona's links go with it (and so with the account).
export const personaSkills = pgTable(
  'persona_skills',
  {
    personaId: uuid('persona_id')
      .notNull()
      .references(() => personas.id, { onDelete: 'cascade' }),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.personaId, t.skillId] }),
    // For the foreign key from skills: Postgres doesn't index the referencing side itself.
    index('persona_skills_skill_id_idx').on(t.skillId),
  ],
);
