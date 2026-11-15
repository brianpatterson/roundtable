# 0024. Build our own Material-style design system on Base UI and CSS Modules

- **Status:** Accepted
- **Date:** 2026-11-15

## Context

The web app's look is one global `index.css` of element selectors (`input`, `button`, `table`) and
a few class names. Every module shares it implicitly, nothing is themed beyond the browser's own
light/dark defaults, and form fields have placeholders but no labels. ADR-0023 set aside
`apps/web/src/design-system/` for themed, reusable components that every web module (and later,
every microfrontend) consumes through one `index.ts`.

What we want from it: a Material Design look, light and dark themes (and room for brand themes),
accessible components (keyboard, focus, screen readers), and code we understand, since this is
also a learning project.

## Options considered

Styling:

1. **CSS Modules + CSS custom properties as tokens.** Built into Vite, no runtime, and a theme is
   just a different set of variable values. Styles are plain CSS.
2. **vanilla-extract.** Type-safe tokens and styles in TypeScript, compiled to static CSS. A
   dependency and a Vite plugin for type safety we don't need yet.
3. **Tailwind.** Fast to write, but components wrap utility classes instead of owning their styles,
   and tokens live in its config.

Components:

1. **MUI (`@mui/material`).** A complete, polished Material set: tables, dialogs, date pickers.
   But it styles through Emotion at runtime and its own theme object, which replaces option 1
   above; it adds tens of KB to the bundle; and it looks like stock Material unless we override
   it component by component.
2. **Google's Material Web (`@material/web`).** Web components, not React, and in maintenance mode.
3. **Base UI (`@base-ui/react`).** Unstyled, accessible components from the MUI team, stable since
   1.0 (December 2025). They handle behavior (keyboard, focus, ARIA, positioning); we write every
   style. One dependency, tree-shaken per component.
4. **Native HTML only.** No dependency, but dialogs, menus and custom selects would mean writing
   accessibility logic ourselves.

## Decision

Our own design system: **Base UI for behavior, CSS Modules for styles, CSS custom properties for
tokens, with a Material 3 look.**

- **Tokens** (`design-system/tokens/tokens.css`): Material 3's color roles (`primary`,
  `on-primary`, `surface`, `on-surface`, `outline`, `error`, …), its type scale, shape (corner
  radii), elevation, state-layer opacities and spacing, all as `--ds-*` variables. Each color is
  defined once with CSS `light-dark()`, so the theme is just `color-scheme`.
- **Themes** (`design-system/theme/`): a `ThemeProvider` that sets `data-theme` on `<html>`
  (`system`, `light` or `dark`), remembered per browser. A brand theme later is another set of
  token values under its own attribute; components don't change.
- **Components** (`design-system/components/<Name>/`): one folder each, with the component, its
  `.module.css`, and its test. Components read only tokens, never raw colors.
- **One door in and out:** only `design-system/` imports `@base-ui/react`, and other code imports
  the design system only through its `index.ts`. `pnpm check:boundaries` enforces both, so
  replacing Base UI later touches one folder.
- **Tests:** Vitest with jsdom and Testing Library, colocated with each component. They test what
  a user sees and does (roles, labels, clicks, keys), not class names.
- **No Storybook yet.** It goes on the roadmap for when the design system has about ten
  components, so there's enough to browse.

## Consequences

- We write and maintain every component's styles. A table, dialog or date picker is our work, not a
  library's; Base UI only covers the behavior.
- The look is ours. It's Material-inspired, so it can drift from Material wherever we want.
- No runtime styling cost and no CSP change; the web app gains one runtime dependency and a test
  setup (the first web tests). The bundle grew from 155 to 200 KB gzipped with the first four
  components, mostly Base UI's Select and its positioning code. Splitting the bundle per route
  or module is the lever if that matters before microfrontends do it anyway.
- Form fields get real labels, which improves accessibility over today's placeholder-only inputs.
- Revisit if we keep needing complex components (data grids, date pickers) faster than we can
  build them: MUI on top of the same tokens would be the fallback. Once microfrontends build
  separately, the design system moves to `packages/design-system` so they share one copy.
