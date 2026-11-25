// The personas module's contract: so far the skill library, the Skills a user practices
// (GLOSSARY.md), behind the identity module's Authorization middleware. Skills are archived and
// restored, never deleted: prep tasks refer to them (ADR-0044 rule 3).
import { ErrorReporter, Schema, SchemaGetter, SchemaTransformation } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/http-api';
import { Authorization } from './identity.js';

/** The most characters a Skill's name can have, once trimmed. */
export const MAX_SKILL_NAME = 80;

/** The most Skills one user can have, archived ones included. */
export const MAX_SKILLS = 200;

/**
 * A Skill's name: 1–80 characters once trimmed. Trimmed in both directions, like the applications
 * module's `Text`, so the typed client sends " System design " as "System design". Two names that
 * differ only in case are the same Skill: the database's unique index decides that, nothing else.
 */
export const SkillName = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String.check(
      Schema.makeFilter((value: string) => {
        const length = value.trim().length;

        if (length === 0) return 'must not be blank';

        return length > MAX_SKILL_NAME ? `must be at most ${MAX_SKILL_NAME} characters` : undefined;
      }),
    ),
    new SchemaTransformation.Transformation(SchemaGetter.trim(), SchemaGetter.trim()),
  ),
);

export const CreateSkill = Schema.Struct({ name: SkillName });

export type CreateSkill = typeof CreateSkill.Type;

/**
 * Renames a Skill, archives it (`archived: true`) or restores it (`archived: false`), or both.
 * Archiving an archived Skill keeps the date it was first archived.
 */
export const UpdateSkill = Schema.Struct({
  name: Schema.optional(SkillName),
  archived: Schema.optional(Schema.Boolean),
}).check(
  Schema.makeFilter((value) =>
    value.name === undefined && value.archived === undefined
      ? 'At least one field is required'
      : undefined,
  ),
);

export type UpdateSkill = typeof UpdateSkill.Type;

/** A Skill as the API returns it: `Date`s in code, ISO 8601 strings on the wire. */
export const Skill = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** When it was archived: hidden from pickers, still shown where it's named. Null while active. */
  archivedAt: Schema.NullOr(Schema.DateFromString),
  createdAt: Schema.DateFromString,
});

export type Skill = typeof Skill.Type;

/** A Skill's id: a UUID. A malformed one fails the params schema: 400, before any handler runs. */
const SkillId = Schema.String.check(Schema.isUUID());

/** Whether `value` could be a Skill's id. */
export const isSkillId = Schema.is(SkillId);

/**
 * A missing Skill, or another user's: always 404, never 403, so existence never leaks. Defined
 * once, here: the endpoints of other modules that take a Skill id (prep tasks) declare this one.
 */
export class SkillNotFound extends Schema.TaggedError<
  SkillNotFound,
  { readonly brand: unique symbol }
>()('SkillNotFound', {}, { httpApiStatus: 404 }) {
  readonly [ErrorReporter.ignore] = true;
}

/**
 * The user already has a Skill by that name, ignoring case and surrounding spaces. `archived` says
 * whether that Skill is archived, so the user can be told to restore it instead.
 */
export class SkillNameTaken extends Schema.TaggedError<
  SkillNameTaken,
  { readonly brand: unique symbol }
>()('SkillNameTaken', { archived: Schema.Boolean }, { httpApiStatus: 409 }) {
  readonly [ErrorReporter.ignore] = true;
}

/** The user already has `MAX_SKILLS` Skills, archived ones included: a 400, like a bad body. */
export class TooManySkills extends Schema.TaggedError<
  TooManySkills,
  { readonly brand: unique symbol }
>()('TooManySkills', {}, { httpApiStatus: 400 }) {
  readonly [ErrorReporter.ignore] = true;
}

export class SkillsApi extends HttpApiGroup.make('skills')
  .add(
    // Every Skill of the user's, archived ones included, by name ignoring case.
    HttpApiEndpoint.get('list', '/', { success: Schema.Array(Skill) }),
    HttpApiEndpoint.post('create', '/', {
      payload: CreateSkill,
      success: Skill.pipe(HttpApiSchema.status(201)),
      error: [SkillNameTaken, TooManySkills],
    }),
    // Renames, archives or restores a Skill. There's no delete: other modules refer to Skills.
    HttpApiEndpoint.patch('update', '/:id', {
      params: { id: SkillId },
      payload: UpdateSkill,
      success: Skill,
      error: [SkillNotFound, SkillNameTaken],
    }),
  )
  .middleware(Authorization)
  .prefix('/api/skills') {}
