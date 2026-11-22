# 0049. Route the web app with TanStack Router, owned by the shell

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

The web app has no routing: the shell shows sign-in or the applications table. Phase 4 needs
pages of their own, starting with one per Application (brianpatterson/roundtable#130), that can
be bookmarked, reloaded and linked to from the Agenda later. Caddy already serves `index.html`
for every path, so client-side routing needs no server change.

The software factory stopped on #130 because it couldn't install the router. Its allowlist permits
`pnpm add` and `pnpm install`, but its sandbox
([ADR-0029](0029-software-factory-credential-hardening.md)) leaves `node_modules/.bin` and
`pnpm-lock.yaml` read-only, so neither works there. Whether the factory should add dependencies at
all is a separate decision; here the router is chosen and installed by hand.

## Options considered

1. **TanStack Router (chosen)**: type-checks paths, params and search params, so a broken link
   fails `tsc`; from the same project as TanStack Query, which already holds server state.
   Smaller ecosystem and fewer examples than React Router.
2. **React Router**: the most widely used, with the most examples. Its types for params are
   weaker unless you adopt its framework mode, which wants to own the build.
3. **No library**: a few `pathname` checks in the shell. Fine for two pages, but every later page
   would re-implement links, params, history and not-found handling.

## Decision

TanStack Router, with **code-based routes** (no file-based routing, so no Vite plugin or generated
route tree). The **shell owns the routes**: it creates the router inside `AuthGate`, so a signed-out
deep link shows sign-in and then the same URL, and maps each path to a module's root component,
passing the parsed params as props. Modules don't import each other and don't define routes
([ADR-0023](0023-modular-monolith-layout.md)); they link through a design-system `Link` built
with the router's `createLink`, so links keep the design system's look and stay type-checked.
Data still loads through TanStack Query, not the router's loaders.

## Consequences

- Every page has a URL and a not-found page; links between pages are checked at compile time.
- Modules depend on the router only through the design system's `Link` and the props the shell
  passes, so a module can later become a microfrontend without taking routes with it.
- One more runtime dependency in the browser bundle (`@tanstack/react-router` and its small
  dependencies).
- A ticket that needs a new package still needs a human to add it first
  (`docs/agents/issue-tracker.md`).
- Revisit file-based routing if the route list grows past what one shell file reads comfortably.
