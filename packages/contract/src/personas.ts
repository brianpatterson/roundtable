// The personas module's contract: the skill library, the Skills a user practices, and Personas,
// the kinds of candidate they apply as, each with the Skills it needs (GLOSSARY.md), behind the
// identity module's Authorization middleware. Both are archived and restored, never deleted:
// prep tasks refer to Skills and Applications to Personas (ADR-0044 rule 3).
import { ErrorReporter, Schema, SchemaGetter, SchemaTransformation } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/http-api';
import { Authorization } from './identity.js';

/**
 * The name of an entry in a Library (GLOSSARY.md), a Skill or a Persona: 1–`max` characters once
 * trimmed. Trimmed in both directions, like the applications module's `Text`, so the typed client
 * sends " System design " as "System design". Two names that differ only in case are the same
 * entry: the database's unique index decides that, nothing else.
 */
const LibraryName = (max: number) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.String.check(
        Schema.makeFilter((value: string) => {
          const length = value.trim().length;

          if (length === 0) return 'must not be blank';

          return length > max ? `must be at most ${max} characters` : undefined;
        }),
      ),
      new SchemaTransformation.Transformation(SchemaGetter.trim(), SchemaGetter.trim()),
    ),
  );

/**
 * Renames an entry in a Library, archives it (`archived: true`) or restores it
 * (`archived: false`), or both. Archiving an archived entry keeps the date it was first archived.
 */
const UpdateLibraryItem = (name: ReturnType<typeof LibraryName>) =>
  Schema.Struct({
    name: Schema.optional(name),
    archived: Schema.optional(Schema.Boolean),
  }).check(
    Schema.makeFilter((value) =>
      value.name === undefined && value.archived === undefined
        ? 'At least one field is required'
        : undefined,
    ),
  );

/** The most characters a Skill's name can have, once trimmed. */
export const MAX_SKILL_NAME = 80;

/** The most Skills one user can have, archived ones included. */
export const MAX_SKILLS = 200;

/** A Skill's name: 1–80 characters once trimmed, ignoring case when compared. */
export const SkillName = LibraryName(MAX_SKILL_NAME);

export const CreateSkill = Schema.Struct({ name: SkillName });

export type CreateSkill = typeof CreateSkill.Type;

/** Renames, archives or restores a Skill. */
export const UpdateSkill = UpdateLibraryItem(SkillName);

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

/** The most characters a Persona's name can have, once trimmed. */
export const MAX_PERSONA_NAME = 80;

/** The most Personas one user can have, archived ones included. */
export const MAX_PERSONAS = 20;

/** The most Skills one Persona can have, archived Skills included. */
export const MAX_PERSONA_SKILLS = 50;

/** A Persona's name: 1–80 characters once trimmed, ignoring case when compared. */
export const PersonaName = LibraryName(MAX_PERSONA_NAME);

export const CreatePersona = Schema.Struct({ name: PersonaName });

export type CreatePersona = typeof CreatePersona.Type;

/** Renames, archives or restores a Persona. */
export const UpdatePersona = UpdateLibraryItem(PersonaName);

export type UpdatePersona = typeof UpdatePersona.Type;

/**
 * A Persona (GLOSSARY.md) as the API returns it: the kind of candidate the user applies as, with
 * the Skills that kind of job needs. `skillIds` are in Skill name order, ignoring case, archived
 * Skills it has included.
 */
export const Persona = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** When it was archived: hidden from pickers, still shown where it's named. Null while active. */
  archivedAt: Schema.NullOr(Schema.DateFromString),
  skillIds: Schema.Array(Schema.String),
  createdAt: Schema.DateFromString,
});

export type Persona = typeof Persona.Type;

/** A Persona's id: a UUID. A malformed one fails the params schema: 400. */
const PersonaId = Schema.String.check(Schema.isUUID());

/** Whether `value` could be a Persona's id. */
export const isPersonaId = Schema.is(PersonaId);

export const AddPersonaSkill = Schema.Struct({ skillId: SkillId });

export type AddPersonaSkill = typeof AddPersonaSkill.Type;

/**
 * A missing Persona, or another user's: always 404, never 403. Defined once, here: the endpoints
 * of other modules that take a Persona id (an Application's) declare this one.
 */
export class PersonaNotFound extends Schema.TaggedError<
  PersonaNotFound,
  { readonly brand: unique symbol }
>()('PersonaNotFound', {}, { httpApiStatus: 404 }) {
  readonly [ErrorReporter.ignore] = true;
}

/**
 * The Persona is archived, so it can't be newly picked: for the endpoints of other modules that
 * take a Persona id (an Application's). Defined once, here.
 */
export class PersonaArchived extends Schema.TaggedError<
  PersonaArchived,
  { readonly brand: unique symbol }
>()('PersonaArchived', {}, { httpApiStatus: 409 }) {
  readonly [ErrorReporter.ignore] = true;
}

/**
 * The user already has a Persona by that name, ignoring case and surrounding spaces. `archived`
 * says whether that Persona is archived, so the user can be told to restore it instead.
 */
export class PersonaNameTaken extends Schema.TaggedError<
  PersonaNameTaken,
  { readonly brand: unique symbol }
>()('PersonaNameTaken', { archived: Schema.Boolean }, { httpApiStatus: 409 }) {
  readonly [ErrorReporter.ignore] = true;
}

/** The user already has `MAX_PERSONAS` Personas, archived ones included: a 400. */
export class TooManyPersonas extends Schema.TaggedError<
  TooManyPersonas,
  { readonly brand: unique symbol }
>()('TooManyPersonas', {}, { httpApiStatus: 400 }) {
  readonly [ErrorReporter.ignore] = true;
}

/** The Persona already has `MAX_PERSONA_SKILLS` Skills: a 400. */
export class TooManyPersonaSkills extends Schema.TaggedError<
  TooManyPersonaSkills,
  { readonly brand: unique symbol }
>()('TooManyPersonaSkills', {}, { httpApiStatus: 400 }) {
  readonly [ErrorReporter.ignore] = true;
}

/** The Skill is archived, so it can't be newly added to a Persona: a 409. */
export class SkillArchived extends Schema.TaggedError<
  SkillArchived,
  { readonly brand: unique symbol }
>()('SkillArchived', {}, { httpApiStatus: 409 }) {
  readonly [ErrorReporter.ignore] = true;
}

export class PersonasApi extends HttpApiGroup.make('personas')
  .add(
    // Every Persona of the user's, archived ones included, by name ignoring case.
    HttpApiEndpoint.get('list', '/', { success: Schema.Array(Persona) }),
    HttpApiEndpoint.post('create', '/', {
      payload: CreatePersona,
      success: Persona.pipe(HttpApiSchema.status(201)),
      error: [PersonaNameTaken, TooManyPersonas],
    }),
    // Renames, archives or restores a Persona. There's no delete: Applications refer to Personas.
    HttpApiEndpoint.patch('update', '/:id', {
      params: { id: PersonaId },
      payload: UpdatePersona,
      success: Persona,
      error: [PersonaNotFound, PersonaNameTaken],
    }),
    // Adds one of the user's active Skills; one the Persona has already is a no-op.
    HttpApiEndpoint.post('addSkill', '/:id/skills', {
      params: { id: PersonaId },
      payload: AddPersonaSkill,
      success: Persona,
      error: [PersonaNotFound, SkillNotFound, SkillArchived, TooManyPersonaSkills],
    }),
    // Removes a Skill; one the Persona doesn't have is a no-op.
    HttpApiEndpoint.delete('removeSkill', '/:id/skills/:skillId', {
      params: { id: PersonaId, skillId: SkillId },
      success: Persona,
      error: [PersonaNotFound, SkillNotFound],
    }),
  )
  .middleware(Authorization)
  .prefix('/api/personas') {}
