# Domain docs

How the engineering skills consume this repo's domain documentation. The repo has **two
contexts**, each with its own glossary, and one ADR folder for both:

- **The product** (`apps/`, `packages/`): `GLOSSARY.md` at the root. Rounds, Personas, Prep.
- **The software factory** (`.github/`, `tools/conductor/`, `scripts/file-batch.sh`, and the
  tickets, specs and pull requests it builds): `docs/factory/GLOSSARY.md`. Tickets, Batches,
  Attempts, Hand-overs.

This section is the map the skills call `CONTEXT-MAP.md`, and each glossary plays the role of a
`CONTEXT.md`; don't create files by those names. Work on the factory reads both glossaries,
since its tickets are written in the product's words.

## Before exploring, read these

- **The glossary of the context you're working in** (above). Terms marked _(planned)_ are
  designed but not built yet.
- **`docs/adr/`**: read the ADRs that touch the area you're working in (`docs/adr/README.md`
  indexes them). Never edit an accepted ADR's decision; supersede it with a new one.
- **`docs/architecture.md`** and **`docs/roadmap.md`**: the current state and where it's going.

## Use the glossary's vocabulary

When your output names a domain concept (an issue title, a refactor proposal, a test name), use
the term as its context's glossary defines it. If the concept isn't there yet, either you're
inventing language the project doesn't use (reconsider) or there's a real gap: `/domain-modeling`
adds it to that glossary, in alphabetical order.

## Flag ADR conflicts

If your output contradicts an existing ADR, say so explicitly rather than silently overriding it:

> _Contradicts ADR-0044 (links between modules), but worth reopening because…_
