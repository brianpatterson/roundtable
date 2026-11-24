# Issue tracker: GitHub

Issues for this repo are GitHub issues in `brianpatterson/roundtable`. Use the `gh` CLI for every
operation; it infers the repo from `git remote -v`.

## The factory builds what's labeled `ready`, in dependency order

The software factory builds an issue the owner labels `ready`, the label this repo uses for the
`ready-for-agent` role (`triage-labels.md`). Its dispatcher
([ADR-0047](../adr/0047-factory-dispatcher.md)) starts one ticket at a time, and only once every
issue blocking it, through GitHub's native issue dependencies, is closed by a merged pull request
that has been deployed. So:

- A whole set of tickets can be labeled `ready` at once; the factory works through it in order.
  The native dependencies decide that order: a "Blocked by" section in the body is for people only.
- Record an edge for every ticket that needs another's change in production first (an
  expand/contract migration, an API the UI calls), and for tickets that would conflict (the same
  files, or both adding a migration).
- Closing a blocker by hand or as not planned stops its dependents with `needs-human`. If its work
  is already merged, remove the dependency first, then close it.
- A ticket that waits on work a human builds (a hand-made pull request) needs an issue for that
  work to be blocked by. Open that issue **before** the pull request merges, and put
  `Closes #<issue>` in the pull request: a `Closes` for an issue that doesn't exist yet at merge
  does nothing. That issue stays open, and its dependents wait forever. Check that the pull
  request's Development panel lists the issue before merging.
- The dispatcher names an open blocker nothing will finish (no `ready` or `building` label, and no
  open pull request that closes it) in its waiting comment on the dependent ticket.
- When publishing a set of tickets, apply **no** label unless the user asks: `ready` is the owner's
  sign-off that a ticket is safe to build, and only the owner's label counts. (The one exception:
  the nightly mutation run labels its own tests-only `mutation` tickets, which the factory builds after
  yours, [ADR-0051](../adr/0051-nightly-mutation-tickets.md), [ADR-0052](../adr/0052-more-mutation-tickets-behind-the-owners.md).)
- Once a ticket is labeled, don't edit its title or description; an edit by anyone but the owner
  removes `ready` until the owner rereads it.

## A batch: a spec and its tickets

A set of tickets cut from one spec (`to-spec`, then `to-tickets`) is a **batch**: publish the spec
as an issue first, then add every ticket as a GitHub sub-issue of it. When the last sub-issue
closes, the factory runs the batch retrospective and closes the spec
([ADR-0064](../adr/0064-factory-retro-per-batch.md)). So:

- The spec gets **no** label: never `ready`, since it isn't built itself, and no pull request
  says `Closes` it.
- **Add a sub-issue**: `gh api --method POST repos/brianpatterson/roundtable/issues/<spec>/sub_issues -F sub_issue_id=<ticket-db-id>`,
  with the ticket's database id as for a blocking edge (below). Sub-issues say which batch a
  ticket belongs to; blocking edges still decide the build order.
- Tickets published without a spec get no retrospective.

## Writing a ticket

Write the body with the headings of the issue forms in `.github/ISSUE_TEMPLATE/`, since the
implementer is written to expect them and won't build a ticket that lacks a clear problem and
testable acceptance criteria:

- **Feature** (`feature.yml`, label `enhancement`): Problem, User story, Acceptance criteria (one
  Given/When/Then per behavior), Modules touched, Design system components, Shared rules, Out of
  scope, Docs impact.
- **Bug** (`bug.yml`, label `bug`): Steps to reproduce, Expected, Actual, Sentry issue, Modules
  touched.

When cutting a spec into tickets, give every rule more than one ticket relies on (an order, a
display name, a day boundary) a single home, and say where it is:

- The first ticket to define a rule that others reuse names the rule's single home in **Shared
  rules**: the module, file and function or constant, so the factory builds it once and later
  tickets import it instead of writing it again.
- A ticket that changes such a rule names, in Shared rules, the tickets and the code that depend on
  it, so the change reaches every one of them.

For example, Round order (`GLOSSARY.md`) lives in one function in `packages/contract`:
`inRoundOrder` in `src/applications.ts`, which the web app and the API both use. In the Rounds
batch it was written three times before it got that home (#166), and the copies disagreed.

The factory never adds, removes or upgrades a package: its sandbox leaves `node_modules` and the
lockfile read-only ([ADR-0050](../adr/0050-factory-adds-no-dependencies.md)). If a ticket needs a new
dependency, say so to the user before publishing: a human adds it (with its `docs/dependencies.md`
row) first, and the ticket uses it. Otherwise the factory stops with `needs-info` and names it.

Add a **Blocked by** section listing blocking issues, and also record each edge as a native
dependency (below). Use `GLOSSARY.md` terms. Never paste user data into an issue.

## Conventions

- **Create an issue**: `gh issue create --title "..." --label enhancement --body-file <file>`
  (or a heredoc).
- **Read an issue**: `gh issue view <number> --comments`.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with `--label` and `--state` filters as needed.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`
- **Blocking edge**: `gh api --method POST repos/brianpatterson/roundtable/issues/<blocked>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is `gh api repos/brianpatterson/roundtable/issues/<n> --jq .id` (the database id, not the number). The dispatcher starts a ticket once every blocker is closed by a deployed pull request.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature
requests; `/triage` reads this flag.)_

## When a skill says "publish to the issue tracker"

Create a GitHub issue, following "Writing a ticket" above.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue labelled `wayfinder:map`; its tickets are
GitHub sub-issues of it (or, where sub-issues aren't available, a task list in the map body plus
`Part of #<map>` atop each child), labelled `wayfinder:<type>` (`research`, `prototype`,
`grilling`, `task`). Blocking uses the native dependencies above. The frontier is the map's open
children with no open blocker and no assignee. Claim with `gh issue edit <n> --add-assignee @me`;
resolve by commenting the answer, closing, and appending a pointer to the map's decisions.
