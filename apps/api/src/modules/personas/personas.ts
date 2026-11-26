import { and, asc, count, eq, inArray, ne, sql } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';
import {
  MAX_PERSONAS,
  MAX_PERSONA_SKILLS,
  PersonaNameTaken,
  PersonaNotFound,
  SkillArchived,
  SkillNotFound,
  TooManyPersonaSkills,
  TooManyPersonas,
  isPersonaId,
  type CreatePersona,
  type Persona,
  type UpdatePersona,
} from '@roundtable/contract';
import { Database } from '../../platform/database/effect.js';
import { changing, type Transaction } from './changing.js';
import { nameKey, personaSkills, personas, skills } from './schema.js';

/** The columns a Persona has in the contract, but for its `skillIds`, which come from the links. */
const personaColumns = {
  id: personas.id,
  name: personas.name,
  archivedAt: personas.archivedAt,
  createdAt: personas.createdAt,
};

type PersonaRow = Omit<Persona, 'skillIds'>;

/** The Database, or a transaction on it: both read the same way. */
type Reader = Database['Service'] | Transaction;

/**
 * Personas: the kinds of candidate a user applies as, each with the Skills it needs. Every method
 * is scoped to the user it's given, and another user's Persona is the same `PersonaNotFound` as a
 * missing one. Another module checks a Persona id only through `findOwned` (ADR-0044 rule 1).
 * Database failures are defects: a 500, reported.
 */
export class Personas extends Context.Service<
  Personas,
  {
    /** The user's Personas, archived ones included, by name ignoring case. */
    readonly list: (userId: string) => Effect.Effect<readonly Persona[]>;
    readonly create: (
      userId: string,
      persona: CreatePersona,
    ) => Effect.Effect<Persona, PersonaNameTaken | TooManyPersonas>;
    /** Renames, archives or restores the user's Persona `id`. */
    readonly update: (
      userId: string,
      id: string,
      changes: UpdatePersona,
    ) => Effect.Effect<Persona, PersonaNotFound | PersonaNameTaken>;
    /**
     * Adds the user's Skill `skillId` to their Persona `id`. One it has already is a no-op, even
     * archived; a newly added one must be active.
     */
    readonly addSkill: (
      userId: string,
      id: string,
      skillId: string,
    ) => Effect.Effect<
      Persona,
      PersonaNotFound | SkillNotFound | SkillArchived | TooManyPersonaSkills
    >;
    /** Removes the user's Skill `skillId` from their Persona `id`; one it doesn't have is a no-op. */
    readonly removeSkill: (
      userId: string,
      id: string,
      skillId: string,
    ) => Effect.Effect<Persona, PersonaNotFound | SkillNotFound>;
    /**
     * The user's Persona `id`, archived or not: for another module that takes a Persona id, before
     * it stores it. Any id that isn't one of the user's Personas, a malformed one included, fails
     * with `PersonaNotFound`.
     */
    readonly findOwned: (userId: string, id: string) => Effect.Effect<Persona, PersonaNotFound>;
  }
>()('roundtable/Personas') {
  static readonly layer = Layer.effect(
    Personas,
    Effect.gen(function* () {
      const db = yield* Database;

      const ownedBy = (userId: string, id: string) =>
        and(eq(personas.id, id), eq(personas.userId, userId));

      /** A transaction that changes the user's Personas or their Skills, holding their lock. */
      const changingPersonas = <A, E>(
        userId: string,
        change: (tx: Transaction) => Effect.Effect<A, E>,
      ) => changing(db, 'personas', userId, change);

      /**
       * The `skillIds` of each of `rows`, in Skill name order ignoring case: the one place that
       * order is decided.
       */
      const withSkills = (reader: Reader, rows: readonly PersonaRow[]) =>
        Effect.gen(function* () {
          const ids = rows.map((row) => row.id);

          const links =
            ids.length === 0
              ? []
              : yield* reader
                  .select({ personaId: personaSkills.personaId, skillId: personaSkills.skillId })
                  .from(personaSkills)
                  .innerJoin(skills, eq(skills.id, personaSkills.skillId))
                  .where(inArray(personaSkills.personaId, ids))
                  .orderBy(asc(nameKey(skills.name)), asc(skills.id))
                  .pipe(Effect.orDie);

          return rows.map((row): Persona => ({
            ...row,
            skillIds: links.filter((link) => link.personaId === row.id).map((link) => link.skillId),
          }));
        });

      /** The user's Persona `id` with its Skills, or `PersonaNotFound`. */
      const read = (reader: Reader, userId: string, id: string) =>
        Effect.gen(function* () {
          const [row] = yield* reader
            .select(personaColumns)
            .from(personas)
            .where(ownedBy(userId, id))
            .pipe(Effect.orDie);

          if (!row) return yield* new PersonaNotFound();

          const [persona] = yield* withSkills(reader, [row]);

          if (!persona) return yield* Effect.die(new Error('a Persona lost its row'));

          return persona;
        });

      /** Fails with `PersonaNotFound` unless the user has a Persona `id`. */
      const checkOwned = (tx: Transaction, userId: string, id: string) =>
        Effect.gen(function* () {
          const [owned] = yield* tx
            .select({ id: personas.id })
            .from(personas)
            .where(ownedBy(userId, id))
            .pipe(Effect.orDie);

          if (!owned) return yield* new PersonaNotFound();
        });

      /** The user's Skill `skillId`, whether it's archived, or `SkillNotFound`. */
      const ownedSkill = (tx: Transaction, userId: string, skillId: string) =>
        Effect.gen(function* () {
          const [skill] = yield* tx
            .select({ archivedAt: skills.archivedAt })
            .from(skills)
            .where(and(eq(skills.id, skillId), eq(skills.userId, userId)))
            .pipe(Effect.orDie);

          if (!skill) return yield* new SkillNotFound();

          return skill;
        });

      /**
       * Fails with `PersonaNameTaken` if the user has another Persona (not `exceptId`) by `name`,
       * compared the way the unique index compares them.
       */
      const checkNameFree = (tx: Transaction, userId: string, name: string, exceptId?: string) =>
        Effect.gen(function* () {
          const [taken] = yield* tx
            .select({ archivedAt: personas.archivedAt })
            .from(personas)
            .where(
              and(
                eq(personas.userId, userId),
                sql`${nameKey(personas.name)} = ${nameKey(sql`${name}`)}`,
                exceptId === undefined ? undefined : ne(personas.id, exceptId),
              ),
            )
            .pipe(Effect.orDie);

          if (taken) return yield* new PersonaNameTaken({ archived: taken.archivedAt !== null });
        });

      return Personas.of({
        list: Effect.fn('Personas.list')(function* (userId: string) {
          const rows = yield* db
            .select(personaColumns)
            .from(personas)
            .where(eq(personas.userId, userId))
            .orderBy(asc(nameKey(personas.name)), asc(personas.id))
            .pipe(Effect.orDie);

          return yield* withSkills(db, rows);
        }),

        create: Effect.fn('Personas.create')(function* (userId: string, persona: CreatePersona) {
          return yield* changingPersonas(userId, (tx) =>
            Effect.gen(function* () {
              yield* checkNameFree(tx, userId, persona.name);

              const [owned] = yield* tx
                .select({ count: count() })
                .from(personas)
                .where(eq(personas.userId, userId))
                .pipe(Effect.orDie);

              // Archived Personas count: they're never deleted, so they'd otherwise grow without bound.
              if ((owned?.count ?? 0) >= MAX_PERSONAS) return yield* new TooManyPersonas();

              const [created] = yield* tx
                .insert(personas)
                .values({ userId, name: persona.name })
                .returning(personaColumns)
                .pipe(Effect.orDie);

              if (!created) return yield* Effect.die(new Error('insert returned no row'));

              return { ...created, skillIds: [] };
            }),
          );
        }),

        update: Effect.fn('Personas.update')(function* (
          userId: string,
          id: string,
          changes: UpdatePersona,
        ) {
          return yield* changingPersonas(userId, (tx) =>
            Effect.gen(function* () {
              yield* checkOwned(tx, userId, id);

              // Its own name in another case isn't taken: that's a rename to the same Persona.
              if (changes.name !== undefined) yield* checkNameFree(tx, userId, changes.name, id);

              yield* tx
                .update(personas)
                .set({
                  ...(changes.name !== undefined && { name: changes.name }),
                  // Archiving an archived Persona keeps the date it was first archived.
                  ...(changes.archived !== undefined && {
                    archivedAt: changes.archived
                      ? sql`coalesce(${personas.archivedAt}, now())`
                      : null,
                  }),
                })
                .where(ownedBy(userId, id))
                .pipe(Effect.orDie);

              return yield* read(tx, userId, id);
            }),
          );
        }),

        addSkill: Effect.fn('Personas.addSkill')(function* (
          userId: string,
          id: string,
          skillId: string,
        ) {
          return yield* changingPersonas(userId, (tx) =>
            Effect.gen(function* () {
              yield* checkOwned(tx, userId, id);

              const skill = yield* ownedSkill(tx, userId, skillId);

              const [linked] = yield* tx
                .select({ skillId: personaSkills.skillId })
                .from(personaSkills)
                .where(and(eq(personaSkills.personaId, id), eq(personaSkills.skillId, skillId)))
                .pipe(Effect.orDie);

              // One it has already stays, archived or not: adding it again changes nothing.
              if (!linked) {
                if (skill.archivedAt !== null) return yield* new SkillArchived();

                const [links] = yield* tx
                  .select({ count: count() })
                  .from(personaSkills)
                  .where(eq(personaSkills.personaId, id))
                  .pipe(Effect.orDie);

                if ((links?.count ?? 0) >= MAX_PERSONA_SKILLS) {
                  return yield* new TooManyPersonaSkills();
                }

                yield* tx
                  .insert(personaSkills)
                  .values({ personaId: id, skillId })
                  .pipe(Effect.orDie);
              }

              return yield* read(tx, userId, id);
            }),
          );
        }),

        removeSkill: Effect.fn('Personas.removeSkill')(function* (
          userId: string,
          id: string,
          skillId: string,
        ) {
          return yield* changingPersonas(userId, (tx) =>
            Effect.gen(function* () {
              yield* checkOwned(tx, userId, id);
              yield* ownedSkill(tx, userId, skillId);

              yield* tx
                .delete(personaSkills)
                .where(and(eq(personaSkills.personaId, id), eq(personaSkills.skillId, skillId)))
                .pipe(Effect.orDie);

              return yield* read(tx, userId, id);
            }),
          );
        }),

        findOwned: Effect.fn('Personas.findOwned')(function* (userId: string, id: string) {
          // A malformed id would fail Postgres's uuid cast: it's no Persona of theirs either.
          if (!isPersonaId(id)) return yield* new PersonaNotFound();

          return yield* read(db, userId, id);
        }),
      });
    }),
  );
}
