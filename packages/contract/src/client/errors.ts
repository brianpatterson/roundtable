// What the user sees when an API call fails. The contract's errors carry no message, so the
// wording lives here, one section per module. A new error in the contract needs a line here.
import { Schema } from 'effect';
import { ApplicationNotFound, MAX_TAGS, RoundNotFound, TooManyTags } from '../applications.js';
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
