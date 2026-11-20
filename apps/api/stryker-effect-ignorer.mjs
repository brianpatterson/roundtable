// A Stryker ignorer (ADR-0027) for Effect names that nothing can observe:
// - a service key, `Context.Service<…>()('roundtable/Mailer')`: Effect finds a service by its
//   class, so an emptied key changes nothing unless two services collide;
// - a span name, `Effect.fn('Mailer.send')`: only a tracer sees it, and the API has none.
// Every such string survives, so leaving them in only lowers the score without pointing at a test
// to write. Error tags (`Schema.TaggedError`) stay mutated: they show up in error reports.
import { PluginKind, declareValuePlugin } from '@stryker-mutator/api/plugin';

/** The string literal that is the first argument of a call to `callee` (e.g. `Effect.fn`). */
const isFirstArgumentOf = (path, matches) =>
  path.isStringLiteral() &&
  path.parentPath.isCallExpression() &&
  path.parent.arguments[0] === path.node &&
  matches(path.parentPath.get('callee'));

const isServiceKey = (callee) =>
  callee.isCallExpression() && callee.get('callee').matchesPattern('Context.Service');

const isSpanName = (callee) => callee.matchesPattern('Effect.fn');

export const strykerPlugins = [
  declareValuePlugin(PluginKind.Ignore, 'effect-names', {
    shouldIgnore(path) {
      if (isFirstArgumentOf(path, isServiceKey))
        return 'An Effect service key: services are found by class.';

      if (isFirstArgumentOf(path, isSpanName)) return 'An Effect span name: only a tracer sees it.';

      return undefined;
    },
  }),
];
