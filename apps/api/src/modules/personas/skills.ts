import { and, asc, count, eq, ne, sql } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';
import {
  MAX_SKILLS,
  SkillNameTaken,
  SkillNotFound,
  TooManySkills,
  isSkillId,
  type CreateSkill,
  type Skill,
  type UpdateSkill,
} from '@roundtable/contract';
import { Database } from '../../platform/database/effect.js';
import { skillNameKey, skills } from './schema.js';

/** A transaction on the Database, as `Database.transaction` hands it to its callback. */
type Transaction = Parameters<Parameters<Database['Service']['transaction']>[0]>[0];

/** The columns a Skill has in the contract: the rest stay inside the module. */
const skillColumns = {
  id: skills.id,
  name: skills.name,
  archivedAt: skills.archivedAt,
  createdAt: skills.createdAt,
};

/**
 * The skill library: a user's Skills, which they add, rename, archive and restore. Every method is
 * scoped to the user it's given, and another user's Skill is the same `SkillNotFound` as a missing
 * one, so the API never confirms an id exists. Another module checks a Skill id only through
 * `findOwned` (ADR-0044 rule 1). Database failures are defects: a 500, reported.
 */
export class Skills extends Context.Service<
  Skills,
  {
    /** The user's Skills, archived ones included, by name ignoring case. */
    readonly list: (userId: string) => Effect.Effect<readonly Skill[]>;
    readonly create: (
      userId: string,
      skill: CreateSkill,
    ) => Effect.Effect<Skill, SkillNameTaken | TooManySkills>;
    /** Renames, archives or restores the user's Skill `id`. */
    readonly update: (
      userId: string,
      id: string,
      changes: UpdateSkill,
    ) => Effect.Effect<Skill, SkillNotFound | SkillNameTaken>;
    /**
     * The user's Skill `id`, archived or not: for another module that takes a Skill id, before it
     * stores it. Any id that isn't one of the user's Skills, a malformed one included, fails with
     * `SkillNotFound`.
     */
    readonly findOwned: (userId: string, id: string) => Effect.Effect<Skill, SkillNotFound>;
  }
>()('roundtable/Skills') {
  static readonly layer = Layer.effect(
    Skills,
    Effect.gen(function* () {
      const db = yield* Database;

      const ownedBy = (userId: string, id: string) =>
        and(eq(skills.id, id), eq(skills.userId, userId));

      /**
       * A transaction that changes the user's Skills, holding their lock: two requests at once
       * can't both pass the limit, or both take one name (which would be a unique violation, a 500).
       */
      const changing = <A, E>(userId: string, change: (tx: Transaction) => Effect.Effect<A, E>) =>
        db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .execute(sql`select pg_advisory_xact_lock(hashtext('skills'), hashtext(${userId}))`)
                .pipe(Effect.orDie);

              return yield* change(tx);
            }),
          )
          .pipe(Effect.catchTag('SqlError', Effect.die));

      /**
       * Fails with `SkillNameTaken` if the user has another Skill (not `exceptId`) by `name`,
       * compared the way the unique index compares them.
       */
      const checkNameFree = (tx: Transaction, userId: string, name: string, exceptId?: string) =>
        Effect.gen(function* () {
          const [taken] = yield* tx
            .select({ archivedAt: skills.archivedAt })
            .from(skills)
            .where(
              and(
                eq(skills.userId, userId),
                sql`${skillNameKey(skills.name)} = ${skillNameKey(sql`${name}`)}`,
                exceptId === undefined ? undefined : ne(skills.id, exceptId),
              ),
            )
            .pipe(Effect.orDie);

          if (taken) return yield* new SkillNameTaken({ archived: taken.archivedAt !== null });
        });

      return Skills.of({
        list: Effect.fn('Skills.list')(function* (userId: string) {
          return yield* db
            .select(skillColumns)
            .from(skills)
            .where(eq(skills.userId, userId))
            .orderBy(asc(skillNameKey(skills.name)), asc(skills.id))
            .pipe(Effect.orDie);
        }),

        create: Effect.fn('Skills.create')(function* (userId: string, skill: CreateSkill) {
          return yield* changing(userId, (tx) =>
            Effect.gen(function* () {
              yield* checkNameFree(tx, userId, skill.name);

              const [owned] = yield* tx
                .select({ count: count() })
                .from(skills)
                .where(eq(skills.userId, userId))
                .pipe(Effect.orDie);

              // Archived Skills count: they're never deleted, so they'd otherwise grow without bound.
              if ((owned?.count ?? 0) >= MAX_SKILLS) return yield* new TooManySkills();

              const [created] = yield* tx
                .insert(skills)
                .values({ userId, name: skill.name })
                .returning(skillColumns)
                .pipe(Effect.orDie);

              if (!created) return yield* Effect.die(new Error('insert returned no row'));

              return created;
            }),
          );
        }),

        update: Effect.fn('Skills.update')(function* (
          userId: string,
          id: string,
          changes: UpdateSkill,
        ) {
          return yield* changing(userId, (tx) =>
            Effect.gen(function* () {
              const [owned] = yield* tx
                .select({ id: skills.id })
                .from(skills)
                .where(ownedBy(userId, id))
                .pipe(Effect.orDie);

              if (!owned) return yield* new SkillNotFound();

              // Its own name in another case isn't taken: that's a rename to the same Skill.
              if (changes.name !== undefined) yield* checkNameFree(tx, userId, changes.name, id);

              const [updated] = yield* tx
                .update(skills)
                .set({
                  ...(changes.name !== undefined && { name: changes.name }),
                  // Archiving an archived Skill keeps the date it was first archived.
                  ...(changes.archived !== undefined && {
                    archivedAt: changes.archived
                      ? sql`coalesce(${skills.archivedAt}, now())`
                      : null,
                  }),
                })
                .where(ownedBy(userId, id))
                .returning(skillColumns)
                .pipe(Effect.orDie);

              if (!updated) return yield* Effect.die(new Error('update returned no row'));

              return updated;
            }),
          );
        }),

        findOwned: Effect.fn('Skills.findOwned')(function* (userId: string, id: string) {
          // A malformed id would fail Postgres's uuid cast: it's no Skill of theirs either.
          if (!isSkillId(id)) return yield* new SkillNotFound();

          const [owned] = yield* db
            .select(skillColumns)
            .from(skills)
            .where(ownedBy(userId, id))
            .pipe(Effect.orDie);

          if (!owned) return yield* new SkillNotFound();

          return owned;
        }),
      });
    }),
  );
}
