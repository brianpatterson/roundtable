// What the user sees when an API call fails. The contract's errors carry no message, so the
// wording lives here, one section per module. A new error in the contract needs a line here.
import { Schema } from 'effect';
import { ApplicationNotFound } from '../applications.js';
import { ReportRateLimited } from '../support.js';

/** A failed API call, with a message fit to show the user. `cause` is the original error. */
export class ApiError extends Error {
  override name = 'ApiError';
}

// Identity: Unauthorized gets no message here. The web app never shows it as an error: its shell
// hands every Unauthorized to the identity module, which returns the user to sign-in with a notice.

// Applications
const isNotFound = Schema.is(ApplicationNotFound);

// Support
const isReportRateLimited = Schema.is(ReportRateLimited);

export function toApiError(cause: unknown): ApiError {
  if (isNotFound(cause)) return new ApiError('That application no longer exists.', { cause });

  if (isReportRateLimited(cause)) {
    return new ApiError(
      "You've sent several reports in the last hour. Please wait a while and try again.",
      { cause },
    );
  }

  // A request body the contract rejects, caught before it's sent: says which field and why.
  if (Schema.isSchemaError(cause)) return new ApiError(cause.message, { cause });

  return new ApiError('Something went wrong. Please try again.', { cause });
}
