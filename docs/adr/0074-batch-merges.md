# 0074. Merge a spec's tickets into a batch branch automatically, and the batch into main by hand

- **Status:** Accepted
- **Date:** 2026-11-26

## Context

The owner merges every factory pull request by hand. On `main` that click is the only human gate
before production: the ruleset requires CI's `check`, `dependency-review` and the two CodeQL
`analyze` checks and **no approvals**, and every merge deploys ([ADR-0014](0014-push-based-deploys.md)).
The reviewer's verdict, the browser tests and the `factory` status ([ADR-0063](0063-factory-status-check.md))
gate nothing. A spec's batch of six tickets is six reviews, six clicks and six deploys, each
click waiting on the owner before the dispatcher can start the next ticket ([ADR-0047](0047-factory-dispatcher.md)).

The owner wants to stop merging each step of a spec, and accepts fewer deploys for it, but not a
staging environment yet.

Forces:

- **Agent-written code must not reach production unseen.** The implementer reads ticket text, and
  for user reports text from outside ([ADR-0041](0041-factory-reads-user-reports.md)).
- **Quality is judged across a spec, not only per ticket.** The architecture review and the retro
  run when a batch closes ([ADR-0064](0064-factory-retro-per-batch.md), [ADR-0067](0067-architecture-review-per-batch.md)),
  today after its code is already live.
- **Fewer, larger deploys** bundle a batch's migrations into one release; [ADR-0073](0073-post-deploy-migrations.md)
  makes that safe.
- **Issues close only when a pull request merges into the default branch.** The dispatcher, the
  retro and the architecture review all start from tickets closing.

## Options considered

1. **Auto-merge factory pull requests into `main`** once CI and the reviewer pass. Fewest moving
   parts, but every ticket deploys with no human having looked, and no staging to catch it.
2. **Merge by hand, but batch the clicks** (merge several green pull requests at once). Still one
   review per ticket, and the dispatcher still waits for each deploy.
3. **Batch branch.** Each spec gets an integration branch. Its tickets' pull requests merge into
   it automatically once their gates pass; the owner reviews and merges one pull request from the
   batch branch into `main`, after the architecture review and retro have run on it. One click and
   one deploy per spec; `main` keeps its human gate.
4. **A staging environment** that every ticket deploys to. Ruled out for now.

## Decision

Option 3.

- **The branch.** When the dispatcher starts the first ticket of a spec, it creates
  `batch/<spec>` from `main` (no agent). Every build of a sub-issue of that spec opens its pull
  request against the batch branch. Tickets outside a spec, the owner's own pull requests,
  Dependabot's and the nightly `mutation` tickets keep targeting `main` as now.
- **The gates.** A new workflow with no agent, `batch-merge.yml`, squash-merges a factory pull
  request into its batch branch when all of these hold on its head commit:
  - the checks `main` requires, plus the browser tests;
  - a new `review` status, set by Review's status job, which is success only when the verdict is
    ready ([ADR-0053](0053-review-verdict-from-blocking-findings.md));
  - no `needs-human` label, and the ticket's `ready` label is the owner's (the dispatcher's rule);
  - the ticket isn't a user report (`user-report` label, ADR-0041);
  - the diff touches none of: `apps/api/src/modules/identity/`, `apps/api/src/platform/config/`,
    `infra/`, `.github/`, `.claude/`, `CLAUDE.md`, `compose.prod.yml`, `apps/*/Dockerfile`,
    `apps/web/Caddyfile`, `deploy/`, any `package.json` or the lockfile.

  A pull request that fails only the last two is labeled `needs-human`, saying which; the owner
  merges it into the batch by hand. Each gate is read from GitHub, never from what an agent
  reported.

- **The ruleset is the boundary.** A ruleset on `batch/**` requires a pull request, the same
  checks and `review`, and blocks force pushes and deletion. The Claude App's token, which agents
  hold, can push to any branch; the ruleset is what keeps it from writing a batch branch
  directly.
  - **Required checks are pinned to GitHub Actions** (the `integration_id` of each required check,
    as `main`'s ruleset already does for its four). A commit status can be written by any token
    with `statuses: write`, so an agent holding the Claude App's token could otherwise post
    `review: success` on its own commit. Pinned, only a workflow's `GITHUB_TOKEN` can satisfy it,
    and agents can't change workflows ([ADR-0029](0029-software-factory-credential-hardening.md);
    `.github/` is also on the list of paths above).
  - **One bypass: a new GitHub App, the batch merger,** whose key only `batch-merge.yml` holds, in
    a `batch-merge` environment that admits only `main` and in which no job runs an agent or code
    from a branch. The factory has no App of its own today (ADR-0072's merge uses the Claude App's
    token), and the job's `GITHUB_TOKEN` can't be the merger: what it pushes starts no CI. The
    bypass lets the App push the one thing that isn't a pull request, a clean merge of `main`
    (below), whose content is already on `main`. It also merges ticket pull requests, but only
    after the workflow's own gates pass. The owner creates the App and its ruleset bypass.
- **Closing tickets.** Merging into a batch branch closes nothing, so `batch-merge.yml` closes the
  ticket as completed, with a link to the merged pull request. The dispatcher counts a blocker in
  the same batch as done once it's merged into the batch branch, and a ticket as no longer in
  flight then; a blocker outside the batch must still be merged and deployed. One ticket at a time
  is unchanged.
- **Keeping up with `main`.** When `main` changes, the same workflow merges it into every open
  batch branch and pushes the merge commit with the batch merger's bypass, only when the merge is
  clean: git made it, with hooks off and no code from either branch run, so it adds nothing that
  isn't on `main` or already in the batch. A conflict is resolved like any other agent-written
  change: the conflict resolver ([ADR-0058](0058-factory-resolves-conflicts.md)) resolves it on a
  `batch-update/<spec>` branch and opens a pull request into the batch, which passes the same gates
  (CI and `review`) before `batch-merge.yml` merges it. Hotfixes go to `main` as now and reach
  batches this way.
- **The batch pull request.** When the last sub-issue closes, `batch-merge.yml` opens
  `batch/<spec>` → `main`, whose description lists each ticket with its pull request, its minor
  findings and its screenshots, and says `Closes #<spec>`. The reviewer reviews it as a whole, CI
  runs on it, and the retro and the architecture review run then, on the batch branch, as they now
  do after a batch closes. The retro no longer closes the spec; merging the batch does. Their
  issues are linked on the batch pull request. The owner can add any of them to the spec as a
  `ready` sub-issue, which builds into the same batch first, or merge and leave them for later.
- **Merging into `main`** uses a merge commit, so each ticket's squashed commit stays in `main`'s
  history and a bad ticket can be reverted alone. `main`'s ruleset allows merge commits as well as
  squash. One merge is one deploy.

This amends ADR-0047 (blockers within a batch, and when a ticket stops being in flight),
ADR-0064 (who closes the spec) and ADR-0067 (the review runs on the batch branch, before the
batch merges).

## Consequences

- One click and one deploy per spec. The owner reads one larger diff, with the reviewer's,
  architecture and retro findings beside it, instead of six small ones as they land.
- The tickets of a batch build back to back, without waiting on the owner or a deploy in
  between.
- A failed deploy rolls back the whole batch, and finding the ticket at fault is harder. Keep
  specs to about a week of tickets.
- Batch branches drift from `main` while they're open; merging `main` in costs an occasional
  conflict-resolver run.
- A batch abandoned halfway leaves a branch; closing its batch pull request (or deleting the branch
  by hand) drops it, and its closed tickets must be reopened.
- `review` becomes a status the factory sets, so a broken status job holds every batch: the
  sweeper ([ADR-0040](0040-factory-sweeper.md)) should flag a pull request that's green but has
  no `review` status.
- Revisit when a staging environment exists: the batch pull request could deploy there first, or
  tickets could merge to `main` behind it. Tests-only `mutation` tickets could auto-merge to `main`
  under the same gates, a separate decision.
