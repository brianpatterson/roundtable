import { sql } from 'drizzle-orm';
import { NodeHttpServer } from '@effect/platform-node';
import { ByteSize, Effect, Layer } from 'effect';
import { HttpIncomingMessage, HttpRouter, HttpServer } from 'effect/http';
import { HttpApiBuilder, HttpApiMiddleware } from 'effect/http-api';
import { RoundtableApi } from '@roundtable/contract';
import { createServer } from 'node:http';
import { AgendaLive, ApplicationsLive } from './modules/applications/index.js';
import { EmailLive, type EmailTransport } from './modules/email/index.js';
import { IdentityLive } from './modules/identity/index.js';
import { PersonasLive, Skills } from './modules/personas/index.js';
import { GitHubIssues, SupportLive } from './modules/support/index.js';
import type { Env } from './platform/config/env.js';
import { MAX_REQUEST_BODY_BYTES } from './platform/http/body-limit.js';
import { Database } from './platform/database/effect.js';
import { PromiseDatabase } from './platform/database/promise.js';
import { errorTrackingLayer, type Sentry } from './platform/observability/error-tracking.js';
import { effectLoggerLayer, type Log } from './platform/observability/logging.js';

// The App: assembles the modules (ADR-0023) into the running API, and owns everything around
// them. This is the only file that knows every module; each module's handlers, middleware and
// tables live in its own folder under modules/.
//
// Callers choose an adapter (serveApp in production, appWebHandler in tests) and pass the
// environment and a logger. Everything a caller used to have to get right is inside:
// - both database pools come from env.DATABASE_URL, so they always reach the same database,
//   and close when the App stops;
// - Sentry starts when the App is built (with SENTRY_DSN) and flushes when it stops;
// - logging and error reporting wrap the whole server, request handling included.

export interface AppOptions {
  readonly env: Env;
  readonly log: Log;
  /** Tests: replaces the email transport chosen from the environment (Resend or the log). */
  readonly emailTransport?: Layer.Layer<EmailTransport>;
  /** Tests: replaces the GitHub client for report issues chosen from the environment. */
  readonly githubIssues?: Layer.Layer<GitHubIssues>;
  /** Tests: Sentry options, e.g. a beforeSend that captures events. Sentry needs SENTRY_DSN. */
  readonly errorTracking?: Partial<Sentry.NodeOptions>;
}

/** The API's own endpoints, outside any module: the health check deploys and monitors use. */
const SystemLive = HttpApiBuilder.group(
  RoundtableApi,
  'system',
  Effect.fn(function* (handlers) {
    const db = yield* Database;

    return handlers.handleAll({
      health: () =>
        db.execute(sql`select 1`).pipe(
          Effect.as('up' as const),
          Effect.orElseSucceed(() => 'down' as const),
          Effect.map((status) => ({ ok: true, db: status, time: new Date().toISOString() })),
        ),
    });
  }),
);

/**
 * Report unexpected failures from every route, not only HttpApi endpoints: HttpApiBuilder wraps
 * its handlers in withErrorReporting, but plain routes (Better Auth's) get no reporting otherwise.
 * ErrorReporter dedupes by cause, so an endpoint failure is still reported once.
 */
const ReportErrors = HttpRouter.middleware((httpEffect) => Effect.withErrorReporting(httpEffect), {
  global: true,
});

/**
 * Bodies Effect reads (every HttpApi endpoint's payload) stop at the limit, with a 413. Better
 * Auth's route gets the body as a Web Request, which this doesn't reach: identity limits it.
 */
const LimitBodySize = HttpRouter.middleware(
  (httpEffect) =>
    Effect.provideService(
      httpEffect,
      HttpIncomingMessage.MaxBodySize,
      ByteSize.bytes(MAX_REQUEST_BODY_BYTES),
    ),
  { global: true },
);

/** Every route, with the modules and the resources they need. */
function routesLayer({ env, log, emailTransport, githubIssues }: AppOptions) {
  const api = HttpApiBuilder.layer(RoundtableApi).pipe(
    Layer.provide([
      SystemLive,
      // Applications checks the Skill ids of prep tasks through personas (ADR-0044).
      ApplicationsLive.pipe(Layer.provide(Skills.layer)),
      AgendaLive,
      PersonasLive,
      SupportLive(env, log, { githubIssues }),
    ]),
    // Identity's endpoints, the Authorization and OptionalSession middleware the groups above
    // rely on, and Better Auth's own routes, all in one.
    Layer.provide(IdentityLive(env, log)),
    // Name the invalid values in 400s: clients, and agents reading a failure, see what was wrong.
    Layer.provide(HttpApiMiddleware.layerProblemDetails({ includeDetails: true })),
  );

  return Layer.mergeAll(api, ReportErrors, LimitBodySize).pipe(
    // The Mailer identity and support send through, with email's limits and transport chosen inside.
    Layer.provide(EmailLive(env, log, { transport: emailTransport })),
    Layer.provide(Database.layer(env.DATABASE_URL)),
    Layer.provide(PromiseDatabase.layer(env.DATABASE_URL)),
  );
}

/**
 * Effect's logs to `log` (pino, redacted) and unexpected failures to Sentry. It must wrap the
 * whole server with provideMerge: request fibers run in the server's context, and anything
 * provided only to the routes misses them (Effect's request logs then go to the console,
 * unredacted). Both adapters below apply it, so no caller has to.
 */
const observability = ({ env, log, errorTracking }: AppOptions) =>
  Layer.mergeAll(effectLoggerLayer(log), errorTrackingLayer(env, errorTracking));

/**
 * The API on a real Node HTTP server, for production (main.ts). Launch it with Layer.launch;
 * interrupting it stops accepting connections, lets in-flight requests finish, then closes the
 * pools and flushes Sentry. server.test.ts checks this wiring end to end.
 */
export function serveApp(options: AppOptions & { readonly port: number; readonly host?: string }) {
  const stopping = Layer.effectDiscard(
    Effect.addFinalizer(() => Effect.sync(() => options.log.info('Shutting down'))),
  );

  return HttpRouter.serve(routesLayer(options)).pipe(
    Layer.provide(
      NodeHttpServer.layer(createServer, { port: options.port, host: options.host ?? '0.0.0.0' }),
    ),
    Layer.provide(stopping),
    Layer.provideMerge(observability(options)),
  );
}

/**
 * The API as a fetch-style handler, in-process with no port: the same routes and observability
 * as serveApp. Tests reach it through `inject`, and the typed client through its `fetch`.
 * `extraRoutes` (tests only) get the same logging and reporting as the real ones. Call
 * `dispose` to stop it: that closes the pools and flushes Sentry.
 */
export function appWebHandler(
  options: AppOptions & { readonly extraRoutes?: Layer.Layer<never, never, HttpRouter.HttpRouter> },
) {
  const routes = options.extraRoutes
    ? Layer.mergeAll(routesLayer(options), options.extraRoutes)
    : routesLayer(options);

  return HttpRouter.toWebHandler(
    routes.pipe(
      Layer.provideMerge(observability(options)),
      Layer.provide(HttpServer.layerServices),
    ),
  );
}
