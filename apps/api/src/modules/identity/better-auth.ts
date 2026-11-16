import { Cause, Context, Effect, ErrorReporter, Layer, Redacted, Schema } from 'effect';
import { PASSWORD_MIN_LENGTH, type AuthProvider } from '@roundtable/contract';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { PromiseDatabase, type Db } from '../../platform/database/promise.js';
import { accounts, sessions, users, verifications } from './schema.js';
import { Mailer, type SendEmail } from '../email/index.js';
import type { Env } from '../../platform/config/env.js';
import { betterAuthLogger, type Log } from '../../platform/observability/logging.js';

interface ConfiguredProvider {
  readonly name: AuthProvider;
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted<string>;
}

/**
 * The social sign-in providers whose credentials are set: the one rule both the auth-config
 * endpoint (which buttons the sign-in page shows) and Better Auth (which ones it accepts) read.
 * A new provider is one entry here, plus its name in the contract's AuthProvider.
 */
export function configuredProviders(env: Env): ConfiguredProvider[] {
  const candidates = [
    { name: 'github', clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
    { name: 'google', clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
  ] as const;

  return candidates.flatMap(({ name, clientId, clientSecret }) =>
    clientId && clientSecret ? [{ name, clientId, clientSecret }] : [],
  );
}

function socialProviders(env: Env): NonNullable<BetterAuthOptions['socialProviders']> {
  return Object.fromEntries(
    configuredProviders(env).map(({ name, clientId, clientSecret }) => [
      name,
      { clientId, clientSecret: Redacted.value(clientSecret) },
    ]),
  );
}

/**
 * An unexpected failure inside Better Auth (a 5xx: the database down, a bug), which it catches
 * and answers itself, so the server's own error reporting never sees it. `cause` is the
 * original error, so its stack and Postgres fields reach Sentry (redacted like any other).
 */
export class BetterAuthFailed extends Schema.TaggedError<
  BetterAuthFailed,
  { readonly brand: unique symbol }
>()('BetterAuthFailed', { cause: Schema.Defect() }) {
  override readonly message = 'Unexpected error in Better Auth';

  // Which part of the app failed, for triage: never user data.
  get [ErrorReporter.attributes]() {
    return { source: 'better-auth' };
  }
}

export function createAuth(
  db: Db,
  env: Env,
  sendEmail: SendEmail,
  log: Log,
  onUnexpectedError: (error: Error) => void = () => {},
) {
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: Redacted.value(env.BETTER_AUTH_SECRET),
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: { user: users, session: sessions, account: accounts, verification: verifications },
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      // No session until the user clicks the emailed link: proves they own the address, which
      // account linking (below) relies on, and stops sign-ups with someone else's email.
      requireEmailVerification: true,
      // A reset means the password may have leaked: sign out every other device.
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await sendEmail({
          kind: 'password-reset',
          to: user.email,
          subject: 'Reset your Roundtable password',
          text: `Reset your password: ${url}\n\nIf you didn't ask for this, ignore this email.`,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      // An unverified user who tries to sign in (or lost the first email) gets a fresh link.
      sendOnSignIn: true,
      // Clicking the link signs them in, instead of making them type the password again.
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendEmail({
          kind: 'verification',
          to: user.email,
          subject: 'Confirm your email for Roundtable',
          text: `Confirm your email to finish signing up: ${url}\n\nThe link expires in 1 hour. If you didn't sign up, ignore this email.`,
        });
      },
    },
    socialProviders: socialProviders(env),
    // Let a user who signed up with email later sign in with GitHub/Google using the same email,
    // instead of creating a second account. Only when BOTH sides have verified it: the provider
    // (Better Auth's default without `trustedProviders`) and our account
    // (`requireLocalEmailVerified`, on by default). Listing providers as trusted skips the
    // provider check: a GitHub account showing someone's address without having verified it would
    // be signed into their account (oauth.test.ts).
    account: { accountLinking: { enabled: true, requireLocalEmailVerified: true } },
    // Better Auth silently disables its CSRF origin check when NODE_ENV=test. Force it on so the
    // test suite exercises the same protection as production.
    advanced: { disableOriginCheck: false },
    // Per client IP, in memory, production only (Better Auth's defaults are per minute, which
    // still allows thousands of emails a day from one machine). the email module adds per-address
    // and daily caps that survive restarts. ADR-0018.
    rateLimit: {
      customRules: {
        '/request-password-reset': { window: 3600, max: 5 },
        '/send-verification-email': { window: 3600, max: 5 },
        '/sign-up/email': { window: 3600, max: 10 },
      },
    },
    // Better Auth catches errors from its endpoints (and from our email callbacks) and answers
    // with an error response, so they never reach the server's error reporting. Report the
    // unexpected ones; 4xx (wrong password, expired token) are normal traffic. Replaces Better
    // Auth's own error logging, so the callback logs too.
    onAPIError: {
      onError: (error) => {
        if (error instanceof APIError && error.statusCode < 500) return;
        onUnexpectedError(
          error instanceof Error ? error : new Error('Non-Error thrown in auth', { cause: error }),
        );
      },
    },
    // Through our logger (and its redaction), not straight to the console.
    logger: betterAuthLogger(log),
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** Better Auth as a service: its own Promise API, called at the edge (ADR-0022). */
export class BetterAuth extends Context.Service<BetterAuth, Auth>()('roundtable/BetterAuth') {
  /**
   * Better Auth calls back with Promises (its emails, its errors), so the callbacks run Effects
   * on the context this layer is built in: the same logger and error reporter as the routes.
   */
  static readonly layer = (env: Env, log: Log) =>
    Layer.effect(
      BetterAuth,
      Effect.gen(function* () {
        const db = yield* PromiseDatabase;
        const { send } = yield* Mailer;
        const run = Effect.runPromiseWith(yield* Effect.context<never>());

        const reportUnexpected = (error: Error) => {
          const cause = Cause.fail(new BetterAuthFailed({ cause: error }));

          void run(
            Effect.logError('Unexpected error in Better Auth', cause).pipe(
              Effect.andThen(ErrorReporter.report(cause)),
            ),
          );
        };

        return createAuth(db, env, (email) => run(send(email)), log, reportUnexpected);
      }),
    );
}
