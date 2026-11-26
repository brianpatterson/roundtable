import { Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { CurrentUser, RoundtableApi } from '@roundtable/contract';
import { Personas } from './personas.js';
import { Skills } from './skills.js';

/**
 * The skill library's endpoints, for the signed-in user (CurrentUser, from the Authorization
 * middleware). The rules live in the Skills service, which other modules use too.
 */
export const SkillsApiLive = HttpApiBuilder.group(
  RoundtableApi,
  'skills',
  Effect.fn(function* (handlers) {
    const library = yield* Skills;

    return handlers.handleAll({
      list: () =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;

          return yield* library.list(user.id);
        }),

      create: ({ payload }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;

          return yield* library.create(user.id, payload);
        }),

      update: ({ params, payload }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;

          return yield* library.update(user.id, params.id, payload);
        }),
    });
  }),
);

/** The Personas endpoints, for the signed-in user. The rules live in the Personas service. */
export const PersonasApiLive = HttpApiBuilder.group(
  RoundtableApi,
  'personas',
  Effect.fn(function* (handlers) {
    const service = yield* Personas;

    return handlers.handleAll({
      list: () =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;

          return yield* service.list(user.id);
        }),

      create: ({ payload }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;

          return yield* service.create(user.id, payload);
        }),

      update: ({ params, payload }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;

          return yield* service.update(user.id, params.id, payload);
        }),

      addSkill: ({ params, payload }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;

          return yield* service.addSkill(user.id, params.id, payload.skillId);
        }),

      removeSkill: ({ params }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;

          return yield* service.removeSkill(user.id, params.id, params.skillId);
        }),
    });
  }),
);
