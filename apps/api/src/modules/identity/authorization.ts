import { Effect, Layer } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { Authorization, CurrentUser, Unauthorized } from '@roundtable/contract';
import { BetterAuth } from './better-auth.js';

/**
 * The session check for every group behind it (applications). No session is a typed
 * Unauthorized (401). A failing session lookup (database down) is a defect: a 500, reported.
 * This is the seam a split would swap: the other modules see only the contract's Authorization
 * and CurrentUser, never Better Auth.
 */
export const AuthorizationLive = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const auth = yield* BetterAuth;

    return Authorization.of((httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;

        const session = yield* Effect.tryPromise(() =>
          auth.api.getSession({ headers: new Headers(request.headers) }),
        ).pipe(Effect.orDie);

        if (!session) return yield* new Unauthorized();

        return yield* Effect.provideService(httpEffect, CurrentUser, { id: session.user.id });
      }),
    );
  }),
);
