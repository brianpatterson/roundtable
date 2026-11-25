---
name: plan-step
description: Take a roadmap step from design to a batch the factory can build - grill it, land the docs, draft the spec and tickets, file them.
disable-model-invocation: true
---

# Plan a roadmap step

Takes one step of `docs/roadmap.md` (or a feature the owner names) to a filed **batch**: a spec
issue whose tickets the factory builds once the owner labels them `ready`. From there the factory
runs on its own: dispatcher, build, review, deploy, and, when the last ticket closes, the batch
retrospective and architecture review.

The owner gates three moments: the design (step 2), the docs PR's merge (step 3), and the drafts
(step 4). At each, stop and wait for their word. Labeling `ready` (step 6) is theirs too.

## 1. Ground

Read the roadmap step, `GLOSSARY.md`, the ADRs it builds on, and the code it will touch. Facts are
your job: look them up (a subagent for a wide search), never ask the owner for one. Done when you
can name every module, endpoint, table and route the step touches, and every glossary term it
uses or adds.

## 2. Grill

Invoke the `grilling` and `domain-modeling` skills (from the `mattpocock-skills` plugin, not this
repo; if they aren't installed, stop and say so) and run them on the step: rounds of numbered
questions, each with your recommendation, until the frontier is empty. `GLOSSARY.md` stands in for
`CONTEXT.md` (`docs/agents/domain.md`); update it the moment a term settles, keeping _(planned)_ on
it. Watch for a step that promises something a later step builds (the Agenda's prep progress
before Prep existed): settle where it moves.

Done when the owner confirms you share the design, including how it splits into tickets and which
decisions get an ADR (the domain-modeling skill's three tests).

## 3. Land the docs

Every decision goes to `main` before any ticket names it: the factory builds from `main` and reads
the ADRs there.

1. Branch from the remote's `main`, leaving the owner's working tree as it is:
   `git fetch origin && git switch -c docs/<step>-design origin/main`. Carry the glossary edits
   over by committing them on the branch; with uncommitted edits elsewhere in the tree, ask first.
2. Take each ADR number right before writing it: the next free one on `origin/main`, past any
   open PR's (`gh pr list` with their files). Other PRs land ADRs while you grill. Use
   `docs/adr/template.md` and add the row to `docs/adr/README.md`.
3. Update `docs/roadmap.md` where the design moved scope between steps.
4. `pnpm check:adrs` and Prettier on the changed files, then commit, push and open the PR with
   the repo's template.

Done when the owner says it's merged and `gh pr view` shows `MERGED`.

## 4. Draft the batch

Write the drafts to a scratch directory outside the repo (the session's scratchpad), in the format
`scripts/file-batch.sh` reads (its header has it): `spec.md`, then `01-<slug>.md`, `02-<slug>.md`
in build order. Each draft starts with `# Title`.

- **Spec:** problem, user story, the design with links to the ADRs, what's out of this batch, and
  the tickets as `{{01}}`, `{{02}}`.
- **Tickets:** the headings of `.github/ISSUE_TEMPLATE/feature.yml`, and the rules of "Writing a
  ticket" in `docs/agents/issue-tracker.md`: one Given/When/Then per behavior, Shared rules naming
  the single home of every rule two tickets share. One ticket per slice that ships and deploys
  on its own (the API before the page that calls it).
- **Blocked by:** in each ticket, a `## Blocked by` section listing `{{NN}}` for earlier tickets
  and `#n` for filed issues. The script turns exactly these into the dispatcher's edges, so list
  every blocker issue-tracker.md asks for (a change needed in production first, the same files).
- **Packages:** for every import a ticket implies, check the importing workspace's
  `package.json` declares it. The factory never adds a package (ADR-0050); a missing one stops
  the build with `needs-info`. Name it to the owner now, so they add it before filing.

Run `scripts/file-batch.sh --dry-run <dir>`. Show the owner its output and the draft paths, with a
short summary of each ticket's acceptance criteria. Done when they approve the drafts.

## 5. File

`scripts/file-batch.sh <dir>`. It files the spec (no label) and tickets (`enhancement`), links
each ticket as a sub-issue, records every edge, and reads them all back. On a failure it names
what it filed: finish those links by hand with the commands in `docs/agents/issue-tracker.md`, or
close them. Report the spec and ticket numbers with their links.

## 6. Label, on the owner's word

When the owner says to, `gh issue edit <n> --add-label ready` on each ticket, never the spec, and
check the labels with `gh issue view`. The dispatcher builds them in edge order from there.
