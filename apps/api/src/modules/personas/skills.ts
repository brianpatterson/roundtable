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
import { Library } from './library.js';
import { skills } from './schema.js';

/**
 * The skill library: a user's Skills, which they add, rename, archive and restore. A Library
 * (`library.ts`), which holds its rules: another user's Skill is the same `SkillNotFound` as a
 * missing one, so the API never confirms an id exists. Another module checks a Skill id only
 * through `findOwned` (ADR-0044 rule 1). Database failures are defects: a 500, reported.
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
      const library = yield* Library.make({
        table: skills,
        lock: 'skills',
        max: MAX_SKILLS,
        isId: isSkillId,
        errors: {
          notFound: () => new SkillNotFound(),
          nameTaken: (archived) => new SkillNameTaken({ archived }),
          tooMany: () => new TooManySkills(),
        },
        // A Skill is its row.
        answer: (_reader, items) => Effect.succeed(items),
      });

      return Skills.of({
        list: library.list,
        create: (userId, skill) => library.create(userId, skill.name),
        update: library.update,
        findOwned: library.findOwned,
      });
    }),
  );
}
