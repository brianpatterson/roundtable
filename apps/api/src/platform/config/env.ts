import { Cause, Config, ConfigProvider, Effect, Exit, Schema } from 'effect';

/**
 * A secret: kept in a `Redacted`, so it prints as `<redacted>` in logs, errors and
 * `JSON.stringify`. Read it with `Redacted.value` only where it's handed to the library that
 * needs it, never to build a string that gets logged.
 */
const Secret = Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(1)));

const WebUrl = Schema.String.check(
  Schema.makeFilter((value: string) => (URL.canParse(value) ? undefined : 'must be a URL')),
);

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

const EnvSchema = Schema.Struct({
  NODE_ENV: Schema.optional(Schema.String),
  /** Includes the database password, so it's a secret too. */
  DATABASE_URL: Secret,
  API_PORT: Schema.Int.pipe(Schema.withDecodingDefaultKey(Effect.succeed(3001))),
  /** Signs session cookies and tokens. Generate with `openssl rand -base64 32`. */
  BETTER_AUTH_SECRET: Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(32))),
  /** Public origin users see in the browser, e.g. http://localhost:5173 or https://example.com. */
  BETTER_AUTH_URL: WebUrl,
  GITHUB_CLIENT_ID: Schema.optional(Schema.String),
  GITHUB_CLIENT_SECRET: Schema.optional(Secret),
  GOOGLE_CLIENT_ID: Schema.optional(Schema.String),
  GOOGLE_CLIENT_SECRET: Schema.optional(Secret),
  /** Resend API key (sending access only). Blank in development: emails go to the log. */
  RESEND_API_KEY: Schema.optional(Secret),
  /** Sender, e.g. `Roundtable <no-reply@mail.example.com>`, on a domain verified in Resend. */
  EMAIL_FROM: Schema.optional(Schema.String),
  /** Sentry project DSN (ADR-0019). Blank: errors only go to the log. Lets anyone send events. */
  SENTRY_DSN: Schema.optional(Secret),
  /** Which build an error came from: the deployed image tag. */
  SENTRY_RELEASE: Schema.optional(Schema.String),
  /** Emails of one kind to one address per 24 hours (ADR-0018). */
  EMAIL_LIMIT_PER_ADDRESS: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(3))),
  /** All emails per 24 hours. Resend's free plan allows 100 a day; this leaves headroom. */
  EMAIL_LIMIT_PER_DAY: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(80))),
  /**
   * Fine-grained GitHub token, this repository only, Issues read/write and nothing else
   * (ADR-0037). Opens an issue for each problem report. Blank: reports are stored and emailed,
   * and no issue is opened.
   */
  GITHUB_ISSUES_TOKEN: Schema.optional(Secret),
  /** Where report issues go, as `owner/name`. Required with GITHUB_ISSUES_TOKEN. */
  GITHUB_ISSUES_REPOSITORY: Schema.optional(
    Schema.String.check(
      Schema.makeFilter((value: string) =>
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) ? undefined : 'must be owner/name',
      ),
    ),
  ),
  /** Who gets each problem report by email, description included. Blank: reports aren't emailed. */
  REPORTS_EMAIL: Schema.optional(Schema.String),
  /** Report issues opened, and report emails sent, per 24 hours: a flood can't fill the repo. */
  REPORT_LIMIT_PER_DAY: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(20))),
}).check(
  // Sign-up requires clicking an emailed link, so production without a real mailer would lock
  // every new user out. Fail at startup instead: the deploy's health check fails and rolls back.
  Schema.makeFilter((env) =>
    env.NODE_ENV !== 'production' || (env.RESEND_API_KEY && env.EMAIL_FROM)
      ? undefined
      : 'RESEND_API_KEY and EMAIL_FROM are required in production',
  ),
  Schema.makeFilter((env) =>
    !env.GITHUB_ISSUES_TOKEN || env.GITHUB_ISSUES_REPOSITORY
      ? undefined
      : 'GITHUB_ISSUES_REPOSITORY is required with GITHUB_ISSUES_TOKEN',
  ),
);

export type Env = typeof EnvSchema.Type;

/**
 * Reads and validates the environment (ADR-0022: Effect `Config`). Blank variables count as
 * unset, since Compose passes unset optional variables as empty strings. Throws on the first
 * invalid variable, naming it.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const exit = Effect.runSyncExit(
    Config.schema(EnvSchema).parse(ConfigProvider.fromEnvRecord(source)),
  );

  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause);

    throw new Error(
      `Invalid environment: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return exit.value;
}
