import { Effect, Layer, Option } from 'effect';
import { HttpServerRequest } from 'effect/http';
import {
  Authorization,
  CurrentUser,
  OptionalSession,
  Unauthorized,
  Viewer,
} from '@roundtable/contract';
import { BetterAuth } from './better-auth.js';

/** The caller's user id, if the request carries a valid session. A failing lookup is a defect. */
const sessionUser = Effect.fnUntraced(function* (auth: BetterAuth['Service']) {
  const request = yield* HttpServerRequest.HttpServerRequest;

  const session = yield* Effect.tryPromise(() =>
    auth.api.getSession({ headers: new Headers(request.headers) }),
  ).pipe(Effect.orDie);

  return Option.fromNullishOr(session).pipe(Option.map(({ user }) => ({ id: user.id })));
});

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
        const user = yield* sessionUser(auth);

        if (Option.isNone(user)) return yield* new Unauthorized();

        return yield* Effect.provideService(httpEffect, CurrentUser, user.value);
      }),
    );
  }),
);

/**
 * The same check for public endpoints (support's reports). A missing or expired session is no
 * failure: the Viewer is `Option.none` instead.
 */
export const OptionalSessionLive = Layer.effect(
  OptionalSession,
  Effect.gen(function* () {
    const auth = yield* BetterAuth;

    return OptionalSession.of((httpEffect) =>
      Effect.flatMap(sessionUser(auth), (viewer) =>
        Effect.provideService(httpEffect, Viewer, viewer),
      ),
    );
  }),
);
