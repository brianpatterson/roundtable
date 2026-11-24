# 0064. Run a retrospective on each batch of factory tickets, from the trail its agents leave

- **Status:** Accepted
- **Date:** 2026-11-23

## Context

The owner plans work in batches: `grill-with-docs` settles a design, `to-spec` writes it down and
`to-tickets` cuts it into tickets the factory builds one at a time
([ADR-0047](0047-factory-dispatcher.md)). The owner runs a `retro` skill by hand to improve the
agent's environment after a session: navigation pointers, automated checks, reviewer rules,
steering files that do nothing. Nothing does that for the factory, which now writes most of the
code. Its mistakes get fixed one pull request at a time (Rework, the CI fixer, the owner's own
commits), and nobody asks what in the environment caused them.

Forces:

- **A batch is the useful unit.** One pull request is an anecdote. The same reviewer finding on
  three tickets of a batch is a pattern, and only the batch shows mistakes made upstream of the
  tickets: wrong boundaries, missing acceptance criteria, a missing blocking edge. But batches
  aren't recorded anywhere: the Rounds tickets (#130–137) are linked only by blocking edges, and
  nothing says "this batch is done".
- **The evidence mostly exists already, in GitHub:** Rework rounds, CI-fixer attempts, the
  reviewer's blocking findings, `needs-info` and `needs-human` stops, conflict resolutions, and
  the owner's own commits on factory branches. The last is the strongest signal: it is exactly
  where the environment failed the agent.
- **Agent runs keep no record.** The `retro` skill reads session transcripts. Factory runs write
  one to the runner (`claude-execution-output.json`) and throw it away.
- **The repository is public,** and so are its artifacts: any signed-in user can download them.
  A build that fetched a user's report has its text in the transcript, which must stay private
  ([ADR-0041](0041-factory-reads-user-reports.md)), and a manipulated agent chooses what its
  transcript says, so anything published from it is a way to publish data
  ([ADR-0029](0029-software-factory-credential-hardening.md)).
- **A retro changes the factory's own instructions,** which only change through a pull request
  that the owner reviews ([ADR-0031](0031-weekly-architecture-review.md) makes the same point).

## Options considered

1. **A retro per pull request.** Cheap to trigger, but mostly noise, and blind to how the tickets
   were cut. It would run about as often as the reviewer for much less return.
2. **A weekly retro over everything merged.** No grouping needed, but the week's work mixes
   batches, and it can't compare what shipped with the spec that asked for it.
3. **A retro per batch, when its last ticket closes (chosen).** The spec becomes the parent issue
   and the tickets its sub-issues, so the batch is recorded and its end can be detected.
4. **Keep whole transcripts as artifacts.** The richest evidence, but public: a report's text
   and anything a manipulated agent wrote would be downloadable.
5. **Keep a trail instead (chosen):** each run's tool calls, shaped the way the denial report
   shapes commands, with none of the tool output or model text.

## Decision

**Batches.** A spec is published as a parent issue, never labeled `ready`, and each ticket cut from
it is added as a GitHub sub-issue (`docs/agents/issue-tracker.md`). No pull request closes the
parent.

**Trails.** Every implementer-family agent run (build, `@claude`, the CI fixer, Rework and the
conflict resolver) runs `.github/factory/agent-trail.sh` after the agent and uploads the result as
an `agent-trail-<issue-N|pr-N>-<job>-<run>-<attempt>` artifact, kept 90 days. The trail holds the
run's outcome, turns, duration, cost and number of denials, and, for each tool call, the tool, a
shaped target and whether it failed. A file is shown only when it lies inside the repository and
every part of its path is plain. A command is shown as each part's program and up to three plain
words, as `report-denials.sh` does. Search patterns, edits, tool output and the agent's text are
left out. The trail passes `guard-secrets.sh` or isn't kept, and a build that fetched a user's
report keeps none.

**The retro.** `.github/workflows/retro.yml` runs when an issue closes, and by hand for a given
parent. Three jobs:

1. `select` (no secrets, `select-retro.sh`): the closed issue's parent is open, every sub-issue is
   closed, the factory built at least one of them, and no `retro` issue covers the parent yet.
2. `retro` (the agent, `contents: read` only): a deterministic step gathers the batch into
   `.retro/` (`gather-retro.sh`): the spec, each ticket and its timeline, comments from the owner
   and the workflows only, each pull request's commits with their authors, and the trails. The
   agent follows `.github/factory/retro.md`, an adaptation of the owner's `retro` skill to the
   factory, reads the evidence and the repository, and returns findings as structured output. It
   has no `gh` and no network.
3. `publish` (no agent, `issues: write`): after `guard-secrets.sh`, one issue labeled `retro`,
   findings ranked by severity, each with its evidence and the change it proposes. It comments on
   the spec with a link and closes it.

The retro issue is never labeled `ready`: the owner splits out the findings worth building.

## Consequences

- Every batch ends with a list of environment fixes drawn from what actually went wrong, at the
  cost of one Opus run per batch.
- The owner's ticket flow gains one step: the spec becomes a parent issue and its tickets
  sub-issues. Tickets published without a parent get no retro, which is also how to opt out.
- The trail can't show why an agent did something, only what it did: which files it read before
  its first edit, which commands failed and how often, how many turns it took. Searching for a
  shaped command across a batch finds repeated failures, but not their messages. If that proves
  too thin, keeping full transcripts privately (encrypted, or outside GitHub) is the next step,
  with its own ADR.
- Trails of runs older than 90 days have expired, so a batch that takes longer than that gets a
  retro from GitHub's records alone.
- A shaped trail can still carry a little data in plain lowercase words and file names, as the
  denial report can. The agent has no credentials in reach (ADR-0029), so what it could leak is
  what is public already.
- Findings that change workflows can't be built by the factory (it may not touch `.github/`), so
  the owner builds those by hand.
- Revisit if the retro issues go unread, which would mean batches are too small or the findings
  too generic, or if the factory starts building work that has no spec.
