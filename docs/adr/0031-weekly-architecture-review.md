# 0031. Review the architecture weekly with Matt Pocock's skill, and check design on every PR

- **Status:** Accepted
- **Date:** 2026-11-17

## Context

Two architecture reviews run by hand with Matt Pocock's `improve-codebase-architecture` skill
(the App assembly in #47, the identity interface in #48) found strong deepening opportunities, and
the owner accepted every recommendation. With the factory writing more of the code, the owner wants
that review to happen regularly, and strong findings to become work without them starting it.

Forces:

- **The skill is built for a conversation.** It explores, writes an HTML report, asks which
  candidate to pursue, then grills the human through it.
- **It's expensive:** a whole-codebase pass with exploration subagents, roughly 20 to 40 minutes of
  Opus on the owner's subscription. And it deliberately looks where code changed recently, so it
  suits a schedule, not every pull request.
- **Architecture changes are the decisions the repo's rules want reviewed:** they cross modules,
  are hard to reverse, and usually need an ADR. And an agent that read the whole codebase is
  writing the tickets, so the owner's `ready` label stays the factory's security gate
  ([ADR-0025](0025-software-factory-implementer.md)).
- **Instructions shape the agent as much as code does,** so they should change only through a
  pull request.

## Options considered

1. **Per pull request, the whole skill.** Too slow and costly for every change, and it would
   re-review the same unchanged code each time.
2. **Per pull request, a design check in the reviewer** using the skill's vocabulary, on the diff
   only. Almost free, since the reviewer already reads the diff.
3. **On a schedule, the whole skill**, unattended, ending at the ranked candidates.
4. **Strong findings straight to implementation.** Fastest, but skips the owner on exactly the
   decisions that most need them, and makes agent-written text the trigger for the implementer.

## Decision

Options 2 and 3, with Strong findings becoming issues the owner accepts by labeling them:

- **Per pull request:** the reviewer ([ADR-0026](0026-software-factory-reviewer.md)) gains a
  **Design** check in `codebase-design`'s vocabulary: a module made shallower, a pass-through that
  fails the deletion test, a seam with one adapter, a leak across an interface. It judges only what
  the diff changes; findings are minor unless they break a `CLAUDE.md` module rule.
- **Weekly** (Mondays, and on demand), `architecture.yml` runs the skill unattended under
  `.github/factory/architect.md`: steps 1 and 2 of the skill, then stop. No questions to anyone;
  instead each candidate carries the questions the grilling would have asked, with recommended
  answers. It writes only the HTML report, uploaded as an artifact for 30 days.
- **Issues:** a deterministic step opens one `architecture` issue per **Strong** candidate, in the
  ticket form's shape, with standard acceptance criteria (behavior unchanged, tests through the
  new interface, the recommendations followed). **Worth exploring** and **Speculative** candidates
  stay in the report. Nothing is labeled `ready`: the owner's label accepts every recommendation,
  and a comment first changes one.
- **No repeats:** each run reads the ADRs and every closed `architecture` issue, and leaves out what
  the owner rejected unless the code has since changed in a way that answers the reason. Open
  issues are already tracked.
- **Vendored skills:** `improve-codebase-architecture` and `codebase-design` from
  `mattpocock/skills` v1.3.2 (MIT), pinned by commit in `.github/factory/skills/` with provenance
  in `UPSTREAM.md`, updated only by pull request. Under `.github/`, the agents can't edit them.
- **Glossary:** unattended runs never write `GLOSSARY.md` (the skill's domain vocabulary file,
  `CONTEXT.md` in earlier versions); they propose entries in the issue.
- **Powers:** read-only like the reviewer: read, search, `git log`/`show`/`diff`/`blame`,
  `gh issue list`/`view`, subagents, and writes only under `./architecture-report/`. Opus, 100
  turns, 45 minutes, the job's own token, and ADR-0029's isolation, scrubbing, denial report and
  secret guard. A suspicious run publishes nothing.

## Consequences

- The owner gets a ranked architecture review every Monday, and each strong finding as a ticket
  that one label turns into a pull request, which then gets CI, mutation testing and the reviewer.
- It costs one long Opus run a week on the owner's subscription.
- Rejections need a short reason when closing the issue, or the next run can't tell why.
- Revisit going straight to implementation for Strong findings once the owner has accepted several
  without changing a recommendation.

## Updates

- **2026-11-17:** the first run's one Strong candidate (#72) fixes a bug, so the fixed criteria
  ("behavior unchanged", and "any change a user could notice" out of scope) contradicted it. Each
  candidate now brings its own acceptance criteria and out-of-scope; only two criteria stay fixed:
  existing tests pass or move to the new interface, and the recommendations are followed. Denied
  tool calls are also printed as log notices, since run summaries can't be read through the API.
