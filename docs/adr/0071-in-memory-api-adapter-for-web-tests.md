# 0071. Test the web app against one in-memory adapter of the contract

- **Status:** Accepted
- **Date:** 2026-11-25

## Context

The web modules call the API through the typed client from `@roundtable/contract/client`
(ADR-0022). Their component tests replaced the server behind its `fetch`, and each test file wrote
its own stand-in: matching paths by string, building untyped Round and Application JSON, and
copying server rules (a schedule replaced as a whole, `outcomeSetByUser`, which Applications the
Agenda leaves out). The copies drifted from the contract: one test's closed statuses were rejected
and withdrawn, but `OPEN_APPLICATION_STATUSES` (ADR-0070) also leaves out accepted. Every feature
paid again: the Agenda (#210) changed five fakes, and each new Round field had to be copied into
all of them, because the typed client rejects a response missing a field. Prep (roadmap step 4)
adds more fields to Rounds and the Agenda. The architecture review raised this as #213.

## Options considered

1. **Keep a fake per test file.** Pros: each test sees all its setup. Cons: the drift and the cost
   above, in every new web module.
2. **One hand-written router with typed fixtures, in `shared/testing/`.** Pros: no Effect in the
   web app's tests. Cons: answers are checked only by the client decoding them, not by the
   contract's encoders; a new endpoint without a fake handler still compiles; path matching
   remains, in one place.
3. **One adapter built from the contract's `HttpApi` with `HttpApiBuilder`**: each group given
   in-memory handlers and served as a web handler, the way the API's `appWebHandler` serves the
   real App in its tests. Pros: params, payloads and answers are decoded and encoded by the
   contract itself; an endpoint without a handler fails to compile; no path matching for the
   contract's endpoints. Cons: the web app needs `effect` as a dev dependency (added in #214);
   the adapter is Effect code in a React app.
4. **Mock Service Worker, or another HTTP mocking library.** Pros: a known tool. Cons: a new
   dependency, and handlers would still be hand-written against paths, outside the contract.

## Decision

Option 3: `apps/web/src/shared/testing/fake-api.ts` is the second adapter at the seam the web
modules already call through, beside the real API over HTTP. It imports only `@roundtable/contract`
and `effect`, so `shared/` still imports no module (ADR-0023). It holds Applications and Rounds in
memory, answers through the contract's schemas, and uses the contract's rules
(`OPEN_APPLICATION_STATUSES`, `isUpcoming`, `inAgendaOrder`, `inRoundOrder`, `sameTag`) rather than
copies. It also answers the three Better Auth routes the shell calls (session, sign-in, sign-out),
outside the contract as in the API.

- **It stores what it's told and infers nothing.** No Outcome inference and no move to
  interviewing: a test that needs either makes the change in an override. Inference is tested on
  the real API (`inference.test.ts`, `rounds.test.ts`).
- **Tests seed it with factories** (`application()`, `round()`) that default every field, so a test
  names only what it cares about, and a new field is one default.
- **One override hook per endpoint**: `fake.on(endpoint, (request) => …)` is given the request
  and answers with the Response the override returns (a 500), or waits on it (a held request) and
  then answers from memory. Every override is dropped before the next test, by
  `setUpFakeApi()`'s shared `beforeEach`.
- **An answer that breaks the contract fails the test**: a 500 no override asked for rejects the
  request with the schema error and fails the test in `afterEach`.

Every applications and shell component test uses it. The identity forms' tests and support's
`ReportProblem` test keep their own small fakes until they need more.

## Consequences

- A server rule the web tests depend on lives in the contract, and the fake's routing in one
  module, so a web test can't drift from the API's rule. Where the old fakes' copies disagreed with
  the API, the tests are now more accurate: the Agenda page's test expects the contract's Agenda
  order, not an order a fake made up.
- A new endpoint must get a handler in the fake before the web app type-checks; a new field gets a
  default in its factory.
- The fake can still disagree with the API on what the contract doesn't say (what a handler
  stores, which fields a change touches). The API's own tests remain the reference for behavior;
  the browser tests (ADR-0065) run against the real API.
- Revisit if the web modules move off the typed client, or if keeping the fake's handlers in step
  with the API's costs more than the drift it prevents.
