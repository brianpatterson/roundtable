import { Effect, Layer } from 'effect';
import { HttpEffect, HttpRouter } from 'effect/http';
import { HttpApiBuilder } from 'effect/http-api';
import { RoundtableApi } from '@roundtable/contract';
import type { Env } from '../../platform/config/env.js';
import type { Log } from '../../platform/observability/logging.js';
import { AuthorizationLive } from './authorization.js';
import { BetterAuth, configuredProviders } from './better-auth.js';

/** The identity group of the contract: which sign-in providers this deployment offers. */
const IdentityApiLive = (env: Env) =>
  HttpApiBuilder.group(RoundtableApi, 'identity', (handlers) =>
    handlers.handleAll({
      authConfig: () =>
        Effect.succeed({ providers: configuredProviders(env).map(({ name }) => name) }),
    }),
  );

/**
 * Better Auth's own endpoints under /api/auth/*, as a plain route: its handler is already
 * Request → Response. BetterAuth is resolved while the route is built, because a route handler's
 * own requirements are per request and Layer.provide on the router wouldn't satisfy them.
 */
const BetterAuthRoute = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* BetterAuth;

    return HttpRouter.add('*', '/api/auth/*', HttpEffect.fromWebHandler(auth.handler));
  }),
);

/**
 * Everything identity gives the App, provided once: its endpoints (auth-config), the
 * Authorization middleware every protected group relies on, and Better Auth's routes, with
 * Better Auth built inside from the App's Mailer and Promise database. If identity ever becomes
 * its own service, this layer is what gets swapped for one that asks it over the network.
 */
export const IdentityLive = (env: Env, log: Log) =>
  Layer.mergeAll(IdentityApiLive(env), AuthorizationLive, BetterAuthRoute).pipe(
    Layer.provide(BetterAuth.layer(env, log)),
  );
