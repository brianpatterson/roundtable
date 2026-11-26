import { and, asc, count, eq, inArray } from 'drizzle-orm';
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
import { Library, type LibraryItem, type Reader, type Transaction } from './library.js';
import { nameKey, personaSkills, personas, skills } from './schema.js';

/**
 * Personas: the kinds of candidate a user applies as, each with the Skills it needs. A Library
 * (`library.ts`), which holds its rules: another user's Persona is the same `PersonaNotFound` as a
 * missing one. What's its own is its Skills. Another module checks a Persona id only through
 * `findOwned` (ADR-0044 rule 1). Database failures are defects: a 500, reported.
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
      /**
       * The `skillIds` of each of `rows`, in Skill name order ignoring case: the one place that
       * order is decided.
       */
      const withSkills = (reader: Reader, rows: readonly LibraryItem[]) =>
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

      // A Persona is a Library entry with its Skills: the Library holds the rules, and answers
      // through `withSkills` inside its transaction.
      const library = yield* Library.make({
        table: personas,
        lock: 'personas',
        max: MAX_PERSONAS,
        isId: isPersonaId,
        errors: {
          notFound: () => new PersonaNotFound(),
          nameTaken: (archived) => new PersonaNameTaken({ archived }),
          tooMany: () => new TooManyPersonas(),
        },
        answer: withSkills,
      });

      /**
       * The user's Skill `skillId`, whether it's archived, or `SkillNotFound`. The row is read
       * `for share`: archiving a Skill holds only the skills lock, not this one, so it waits for
       * this transaction to commit (or this read waits for the archive) and no link is added to a
       * Skill archived in between.
       */
      const ownedSkill = (tx: Transaction, userId: string, skillId: string) =>
        Effect.gen(function* () {
          const [skill] = yield* tx
            .select({ archivedAt: skills.archivedAt })
            .from(skills)
            .where(and(eq(skills.id, skillId), eq(skills.userId, userId)))
            .for('share')
            .pipe(Effect.orDie);

          if (!skill) return yield* new SkillNotFound();

          return skill;
        });

      return Personas.of({
        list: library.list,
        create: (userId, persona) => library.create(userId, persona.name),
        update: library.update,

        addSkill: Effect.fn('Personas.addSkill')(function* (
          userId: string,
          id: string,
          skillId: string,
        ) {
          return yield* library.changing(userId, id, (tx) =>
            Effect.gen(function* () {
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
            }),
          );
        }),

        removeSkill: Effect.fn('Personas.removeSkill')(function* (
          userId: string,
          id: string,
          skillId: string,
        ) {
          return yield* library.changing(userId, id, (tx) =>
            Effect.gen(function* () {
              yield* ownedSkill(tx, userId, skillId);

              yield* tx
                .delete(personaSkills)
                .where(and(eq(personaSkills.personaId, id), eq(personaSkills.skillId, skillId)))
                .pipe(Effect.orDie);
            }),
          );
        }),

        findOwned: library.findOwned,
      });
    }),
  );
}
