# Glossary

Roundtable's domain language: the words the code, tickets and reviews use for things in the
product. The weekly architecture review proposes entries in its issues (ADR-0031); the pull
request that builds one adds them here. Terms marked _(planned)_ were designed ahead for Phase 4
(`docs/roadmap.md`) and aren't built yet: until the pull request that builds one removes the
mark, the code is what's true.

- **Agenda** _(planned)_: the user's upcoming Rounds in date order, each with its Application, Interview type,
  time left and prep progress. The answer to "what should I prepare for next?".
- **Application**: one job the user is pursuing at one company, from the moment they save the
  posting until it ends (an offer accepted, a rejection, or a withdrawal). An application can
  exist before it is sent _(planned)_; its **applied date** is when it was sent, not when it was saved.
  Uses at most one Persona. Its **status** is a coarse stage set by the user: saved, applied,
  interviewing, offer, accepted, rejected or withdrawn (_planned_: today's code reads saved but
  can't set it yet, and reads a stored screening as interviewing); Rounds carry the detail within
  interviewing. Adding the first Round moves an applied Application to interviewing.
- **Document** _(planned)_: a resume or a cover letter. A Persona's documents have a **draft** the user edits
  freely and a history of Versions.
- **Fork** _(planned)_: an Application's own copy of a Version, tailored for that company (a cover letter
  addressed to them, two reworded bullets). It remembers the Version it came from and never
  changes the Persona's draft.
- **Interview type** _(planned)_: what a Round tests, from a fixed list (recruiter screen, hiring manager,
  coding, system design, behavioral, take-home, presentation, other). Fixed so analytics can
  compare like with like; finer detail goes in Tags.
- **Outcome** (of a Round) _(planned)_: whether the user advanced past it: pending, passed, failed or unknown
  (never told). Inferred where possible: adding the next Round passes the earlier pending ones,
  and a rejection fails the latest pending ones; the user can override either. Often known days
  later, and a rejection after several same-day Rounds fails them all. Compare Self-rating.
- **Pass rate** _(planned)_: for a group of Rounds (one Interview type, say), the share of those with a known
  Outcome that passed. Pending and unknown Rounds don't count either way, and the number of
  Rounds behind it is always shown with it.
- **Persona** _(planned)_: one way the user presents themselves for a kind of job (for example "Backend
  engineer" or "Engineering manager"). It holds the resume, cover letter and skills to practice
  for applications made as that persona. Not to be confused with the user's account.
- **Prep** _(planned)_: what the user does to get ready for one Round: notes, and **prep tasks** ("redo the LRU
  cache problem"), each of which can name the Skill it practices.
- **Round** _(planned)_: one interview within an Application, of one Interview type. It has a scheduled time
  (a start and a duration), a due date (a take-home), or neither yet (the company named the step
  but hasn't booked it). An onsite of four back-to-back
  interviews is four Rounds on the same day, not one.
- **Self-rating** _(planned)_: the user's own score for a Round, given right after it, with a note on what
  went wrong. Immediate and per Round, where the Outcome is late and coarse.
- **Session expiry**: the moment the API answers `Unauthorized` for a user the web app still
  shows as signed in. Owned by the identity module, which returns the user to sign-in with a
  notice ([ADR-0032](docs/adr/0032-web-identity-owns-session-expiry.md)).
- **Skill** _(planned)_: something the user practices ("system design", "behavioral stories"). Each user has
  one skill library; a Persona picks the Skills it needs, so practice counts for every Persona
  that shares a Skill.
- **Tag** _(planned)_: a free-form label on a Round for detail the Interview type doesn't carry ("React",
  "SQL", "live debugging").
- **Version** _(planned)_: a frozen copy of a Document's draft. One is made automatically when an
  Application is sent with a draft that changed since the last Version, and the user can save
  one by hand. Every Application that was sent points at the Version (or Fork) it went out with.
