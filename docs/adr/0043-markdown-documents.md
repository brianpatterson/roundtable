# 0043. Write resumes and cover letters in Markdown, edited in the app and rendered to PDF

- **Status:** Accepted
- **Date:** 2026-11-21

## Context

A Persona's Documents (resume, cover letter) are versioned and can be forked per Application
([ADR-0042](0042-version-persona-documents.md)). That history is only worth keeping if the user
can see what changed between two Versions, or between a Fork and its Version. Companies almost
always want a PDF. We'd like an editor embedded in the app rather than a round trip through
Word.

## Options considered

1. **Uploaded files** (PDF, DOCX), edited elsewhere. No editor to build, any layout the user
   likes, but Versions are opaque files: no diff, no in-app editing.
2. **Markdown** in an embedded editor, rendered to PDF from a resume template. Plain text diffs
   line by line and the editor is cheap; layouts are limited to the templates we offer.
3. **Rich text** in a ProseMirror-based editor, exported to PDF. Closest to Word, but stored as a
   JSON document whose diffs are hard to read, and a heavier editor to ship.

## Decision

Option 2: Documents are Markdown, edited in the app, and turned into a PDF from a template when
the user downloads or sends them. The editor, the templates and how the PDF is rendered are
decided when the feature is built.

## Consequences

- Versions and Forks can be compared as text, and stored cheaply.
- Users who want a precise custom layout are limited to our templates; that's the main reason to
  revisit (by adding uploads alongside Markdown, not replacing it).
- PDF rendering is new work, either in the browser or on the server, with its own ADR.
