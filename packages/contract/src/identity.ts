// The identity module's contract: who the caller is, and how they can sign in. Better Auth's own
// routes under /api/auth/* are mounted by the API outside this contract.
import { Context, ErrorReporter, Option, Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from 'effect/http-api';

/** The shortest password Better Auth accepts; the web app's forms say and check the same. */
export const PASSWORD_MIN_LENGTH = 10;

export const AuthProvider = Schema.Literals(['github', 'google']);

export type AuthProvider = typeof AuthProvider.Type;

/** Which social sign-in providers this deployment has configured. */
export const AuthConfig = Schema.Struct({ providers: Schema.Array(AuthProvider) });

export type AuthConfig = typeof AuthConfig.Type;

// Expected outcomes set ErrorReporter.ignore, or Sentry reports every 401 as an error
// (ADR-0022). contract.test.ts fails if a 4xx error forgets it.
export class Unauthorized extends Schema.TaggedError<
  Unauthorized,
  { readonly brand: unique symbol }
>()('Unauthorized', {}, { httpApiStatus: 401 }) {
  readonly [ErrorReporter.ignore] = true;
}

/** The signed-in user, provided by the Authorization middleware to every handler behind it. */
export class CurrentUser extends Context.Service<CurrentUser, { readonly id: string }>()(
  'roundtable/CurrentUser',
) {}

/**
 * Resolves the caller to a CurrentUser, or fails with Unauthorized. Other modules' groups put
 * this middleware in front of their endpoints; the identity module implements it.
 */
export class Authorization extends HttpApiMiddleware.Service<
  Authorization,
  { provides: CurrentUser; requires: never }
>()('roundtable/Authorization', { error: Unauthorized }) {}

/**
 * Who is calling a public endpoint, if anyone: `Option.some` with a valid session, `Option.none`
 * without one. Provided by the OptionalSession middleware.
 */
export class Viewer extends Context.Service<Viewer, Option.Option<{ readonly id: string }>>()(
  'roundtable/Viewer',
) {}

/**
 * For public endpoints that link what they store to the caller when there is one (a problem
 * report). Never fails: no session, or an expired one, is simply no Viewer. The identity module
 * implements it.
 */
export class OptionalSession extends HttpApiMiddleware.Service<
  OptionalSession,
  { provides: Viewer; requires: never }
>()('roundtable/OptionalSession') {}

/** Public: the sign-in page asks which providers to offer before anyone is signed in. */
export class IdentityApi extends HttpApiGroup.make('identity').add(
  HttpApiEndpoint.get('authConfig', '/api/auth-config', { success: AuthConfig }),
) {}
