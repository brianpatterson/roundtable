# 0042. Version a Persona's documents and point each sent Application at its Version

- **Status:** Accepted
- **Date:** 2026-11-21

## Context

A Persona (see `GLOSSARY.md`) holds a resume and a cover letter that the user keeps editing.
Applications are sent with them, and an interview can come months later: by then the Persona's
resume has changed, but the user needs to reread exactly what that company saw. We also want to
see how a resume changed over time, and eventually which version got the most callbacks.

Size isn't the constraint. Documents are text, about 5–30 KB each; a few hundred applications
add up to tens of megabytes.

## Options considered

1. **Live link**: an Application points at the Persona's current documents. Simplest, but
   editing the resume rewrites history: the company's copy is lost.
2. **Snapshot per Application**: sending copies the documents onto the Application. Keeps
   what was sent, but there's no history of the Persona's documents themselves, and the same
   resume sent to 30 companies is 30 unrelated copies that can't be grouped.
3. **Versions**: a Document has an editable draft and frozen Versions; a sent Application points
   at one. Keeps what was sent, gives a history, and groups applications by the Version they
   used. The cost is deciding when a Version is made.

## Decision

Option 3. A Version is made automatically when an Application is sent with a draft that changed
since the last Version, and by hand when the user chooses to; autosaves only touch the draft.
An Application can **fork** a Version into its own tailored copy, which records the Version it
came from and leaves the Persona's draft alone.

## Consequences

- What a company saw is never lost, and analytics can group Applications by Version.
- Versions and Forks are immutable once an Application points at them: deleting a Persona or a
  Version must not delete what a sent Application used.
- Two kinds of copy (Version, Fork) and a draft are more to explain in the UI than a single
  document.
- Revisit if documents become large binary files (uploaded PDFs) rather than text, where storage
  and diffing change the trade-off.
