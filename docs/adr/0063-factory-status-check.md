# 0063. Show the factory's progress on a pull request as a `factory` commit status

- **Status:** Accepted
- **Date:** 2026-11-23

## Context

A pull request can go through several factory rounds before it's the owner's turn: a review after
green CI ([ADR-0033](0033-review-every-pull-request.md)), up to two reworks when it asks for
changes ([ADR-0037](0037-software-factory-rework.md)), one pass over minor findings
([ADR-0053](0053-review-verdict-from-blocking-findings.md)), and each push starts CI and a review
again. The owner wants to see from the pull request page whether the factory is finished with it.

The page shows only part of it. The review comment names the commit it reviewed and its verdict,
but the Review and Rework workflows start from `workflow_run`, and those runs don't appear in a
pull request's checks. While a review or rework runs, the page looks the same as when nothing does.
Whether the minor pass has happened is in a hidden HTML marker. Working it out means reading the
comments, the labels, the commit SHAs and the Actions tab together.

## Options considered

1. **Document how to read the page**: free, but it doesn't close the gap. A running review or
   rework is still invisible.
2. **A check run per workflow (Checks API)**: room for a Markdown summary, but each workflow
   would own its own check, which still leaves the owner to combine Review's and Rework's, and the
   summary would repeat the review comment.
3. **One `factory` commit status on the reviewed commit (Statuses API), set by every workflow that
   moves the pull request forward**: one line on the page, which the newest commit replaces, with a
   description saying what's happening and a link to the run.

## Decision

Option 3. `.github/factory/factory-status.sh` sets the `factory` status on a commit:

- **pending** ("Working: …") while the factory works on it: Review sets it as the review starts,
  Review's last job sets "deciding on a rework" when Rework will take the pull request, and Rework's
  select job sets "reworking, attempt N of 2" or "fixing the minor findings".
- **success** ("Done: …") when it's the owner's turn: ready (with or without minor findings), changes
  asked on a pull request the factory doesn't rework, or `needs-human` from Rework or the sweeper.
- **error** ("Stopped: …") when a review or rework run ended without finishing.

No `factory` status on the latest commit means the factory hasn't reached it: CI is running or
failed. A rework that pushes a fix leaves its old commit alone; the new commit's review sets its own.

Each status is set by a small job of its own, never by a job that runs an agent, so no agent's token
gains `statuses: write` ([ADR-0029](0029-software-factory-credential-hardening.md)). Failing to set
a status is a warning, not a failed job: nothing waits on it.

Green means the factory is done, not that the change is ready to merge: a "Done: changes needed"
status is green too. A failing status would show the owner's turn in red, but the Claude desktop
app's Auto-fix and the CI fixer's agent read failing checks as CI to fix.

## Consequences

- The owner reads one line: yellow, the factory is working; green, it's their turn, and the
  description says why; red, a run broke, and the link opens it.
- Review and Rework each gain a short job, and the sweeper `statuses: write`.
- `--reviewed` repeats Rework's test of which pull requests it takes (a `factory` label without
  `needs-human`); `test-factory-status.sh` pins the two together.
- A status could be left `pending` if a run dies between setting it and its status job (a cancelled
  workflow). The sweeper's `needs-human` hand-off on factory pull requests sets it as done; on the
  owner's own pull requests, labeling `review` reruns the review.
- The status isn't required for merging. Making it required would block the owner's pull requests
  whose CI never passes; revisit if merges before the factory is done become a problem.
