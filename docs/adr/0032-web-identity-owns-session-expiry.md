# 0032. Route every Unauthorized in the web app to identity, through the shell's query cache

- **Status:** Accepted
- **Date:** 2026-11-17

## Context

When a session expires on the server, the next applications call answers 401. The contract
client turned that into the text "You have been signed out. Sign in again.", and the applications
table or form showed it as an error. Identity's `AuthGate` owns the session but never heard about
the 401, so the signed-in view stayed up until Better Auth happened to re-check the session (on
focus, for instance). Every feature module would have had to handle 401 itself to do better, and
no test covered expiry at all (issue #72, from the weekly architecture review, ADR-0031).

Under ADR-0023 modules don't import each other, so applications can't call identity directly.

## Options considered

1. **Rely on Better Auth's refetch on focus.** No code, but a user acting in a focused tab keeps
   seeing errors, and there is still nothing to test.
2. **Each feature module checks for Unauthorized** and asks identity to sign out (through a prop
   from the shell). Every module, current and future, repeats the same handling, and one that
   forgets shows an error instead.
3. **Wrap the shared API client** so it reports 401s. `shared/` may not import modules, so the
   wrapper would need identity injected, and it misses errors that don't come through it.
4. **The shell's `QueryCache` and `MutationCache` `onError`** route every `ApiError` whose cause is
   `Unauthorized` to one function identity exports. The shell already owns the `QueryClient` and
   is the one place allowed to know both modules.

## Decision

Option 4. Identity's `index.ts` exports `sessionEnded()`. The shell's `QueryClient` calls it for
every query or mutation that fails with `Unauthorized`, and doesn't retry those queries. `AuthGate`
then hides the signed-in view at once, clears the query cache, has Better Auth re-check the session
(once, however many requests failed), and shows `SignInPage` with the notice "You were signed out.
Sign in again.". The contract client no longer words `Unauthorized`; feature modules never handle
it.

`AuthGate` remembers which session ended by its id, because Better Auth may still hold it until the
re-check answers: a new sign-in is a different session and shows the app again. Signing out marks
the session the same way without the notice, so a request in flight that answers 401 afterwards
isn't mistaken for an expiry.

## Consequences

- The whole session lifecycle (sign-in, sign-out, expiry) lives in identity, and every web module
  gets expiry right with no code of its own. `shell/App.test.tsx` covers it for all of them;
  `modules/identity/AuthGate.test.tsx` covers `sessionEnded` at identity's interface.
- Identity's web interface grows from one component to a component and a function. The function
  is called from outside React, so identity keeps a small listener set that `AuthGate` subscribes
  to; with no `AuthGate` mounted, `sessionEnded()` does nothing.
- A call that goes around TanStack Query (a bare `api.*` call in an event handler) isn't covered.
  Today every call goes through a query or a mutation; revisit if that changes, or if a microfrontend
  split gives each module its own `QueryClient` (each would then need the same `onError`).
