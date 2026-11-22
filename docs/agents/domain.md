# Domain docs

How the engineering skills consume this repo's domain documentation. The repo is
**single-context**: one glossary and one ADR folder for the whole product, even though it's a pnpm
workspace.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root: the domain language. It plays the role the skills call
  `CONTEXT.md`; there is no `CONTEXT.md` or `CONTEXT-MAP.md`, so don't create one. Terms marked
  _(planned)_ are designed but not built yet.
- **`docs/adr/`**: read the ADRs that touch the area you're working in (`docs/adr/README.md`
  indexes them). Never edit an accepted ADR's decision; supersede it with a new one.
- **`docs/architecture.md`** and **`docs/roadmap.md`**: the current state and where it's going.

## Use the glossary's vocabulary

When your output names a domain concept (an issue title, a refactor proposal, a test name), use
the term as `GLOSSARY.md` defines it. If the concept isn't there yet, either you're inventing
language the project doesn't use (reconsider) or there's a real gap: `/domain-modeling` adds it
to `GLOSSARY.md`, in alphabetical order.

## Flag ADR conflicts

If your output contradicts an existing ADR, say so explicitly rather than silently overriding it:

> _Contradicts ADR-0044 (links between modules), but worth reopening because…_
