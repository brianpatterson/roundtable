// What the user sees when an API call fails. The contract's errors carry no message, so the
// wording lives here, one section per module. A new error in the contract needs a line here.
import { Schema } from 'effect';
import {
  ApplicationNotFound,
  MAX_PREP_TASKS,
  MAX_TAGS,
  PrepTaskNotFound,
  RoundNotFound,
  TooManyPrepTasks,
  TooManyTags,
} from '../applications.js';
import {
  MAX_PERSONAS,
  MAX_PERSONA_SKILLS,
  MAX_SKILLS,
  PersonaArchived,
  PersonaNameTaken,
  PersonaNotFound,
  SkillArchived,
  SkillNameTaken,
  SkillNotFound,
  TooManyPersonaSkills,
  TooManyPersonas,
  TooManySkills,
} from '../personas.js';
import { ReportNotFound, ReportRateLimited } from '../support.js';

/** A failed API call, with a message fit to show the user. `cause` is the original error. */
export class ApiError extends Error {
  override name = 'ApiError';
}

// Identity: Unauthorized gets no message here. The web app never shows it as an error: its shell
// hands every Unauthorized to the identity module, which returns the user to sign-in with a notice.

// Applications
const isNotFound = Schema.is(ApplicationNotFound);

const isRoundNotFound = Schema.is(RoundNotFound);

const isTooManyTags = Schema.is(TooManyTags);

const isPrepTaskNotFound = Schema.is(PrepTaskNotFound);

const isTooManyPrepTasks = Schema.is(TooManyPrepTasks);

// Personas
const isSkillNotFound = Schema.is(SkillNotFound);

const isSkillNameTaken = Schema.is(SkillNameTaken);

const isTooManySkills = Schema.is(TooManySkills);

const isSkillArchived = Schema.is(SkillArchived);

const isPersonaNotFound = Schema.is(PersonaNotFound);

const isPersonaArchived = Schema.is(PersonaArchived);

const isPersonaNameTaken = Schema.is(PersonaNameTaken);

const isTooManyPersonas = Schema.is(TooManyPersonas);

const isTooManyPersonaSkills = Schema.is(TooManyPersonaSkills);

// Support
const isReportRateLimited = Schema.is(ReportRateLimited);

// Only the factory reads reports back (ADR-0041); no page shows this.
const isReportNotFound = Schema.is(ReportNotFound);

export function toApiError(cause: unknown): ApiError {
  if (isNotFound(cause)) return new ApiError('That application no longer exists.', { cause });

  if (isRoundNotFound(cause)) return new ApiError('That round no longer exists.', { cause });

  if (isTooManyTags(cause)) {
    return new ApiError(`A round can have at most ${MAX_TAGS} tags.`, { cause });
  }

  if (isPrepTaskNotFound(cause)) return new ApiError('That prep task no longer exists.', { cause });

  if (isTooManyPrepTasks(cause)) {
    return new ApiError(`A round can have at most ${MAX_PREP_TASKS} prep tasks.`, { cause });
  }

  if (isSkillNotFound(cause)) return new ApiError('That skill no longer exists.', { cause });

  if (isSkillNameTaken(cause)) {
    return new ApiError(
      cause.archived
        ? 'You have an archived skill with that name. Restore it instead.'
        : 'You already have a skill with that name.',
      { cause },
    );
  }

  if (isTooManySkills(cause)) {
    return new ApiError(`You can have at most ${MAX_SKILLS} skills, archived ones included.`, {
      cause,
    });
  }

  if (isSkillArchived(cause)) {
    return new ApiError('That skill is archived. Restore it to add it.', { cause });
  }

  if (isPersonaNotFound(cause)) return new ApiError('That persona no longer exists.', { cause });

  if (isPersonaArchived(cause)) {
    return new ApiError('That persona is archived. Restore it to pick it.', { cause });
  }

  if (isPersonaNameTaken(cause)) {
    return new ApiError(
      cause.archived
        ? 'You have an archived persona with that name. Restore it instead.'
        : 'You already have a persona with that name.',
      { cause },
    );
  }

  if (isTooManyPersonas(cause)) {
    return new ApiError(`You can have at most ${MAX_PERSONAS} personas, archived ones included.`, {
      cause,
    });
  }

  if (isTooManyPersonaSkills(cause)) {
    return new ApiError(`A persona can have at most ${MAX_PERSONA_SKILLS} skills.`, { cause });
  }

  if (isReportRateLimited(cause)) {
    return new ApiError(
      "We've received a lot of reports in the last hour. Please try again later.",
      { cause },
    );
  }

  if (isReportNotFound(cause)) return new ApiError('That report no longer exists.', { cause });

  // A request body the contract rejects, caught before it's sent. The schema's own text (which
  // field and why) is library wording, not for the user: it stays in `cause`, for logs and Sentry.
  // A form that wants to name a field's problem checks that field itself (RoundTags does).
  if (Schema.isSchemaError(cause)) {
    return new ApiError('Check what you entered and try again.', { cause });
  }

  return new ApiError('Something went wrong. Please try again.', { cause });
}
