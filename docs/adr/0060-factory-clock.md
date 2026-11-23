# 0060. Start the factory's sweeps from a Cloudflare Cron Trigger, and alert when an hour passes without one

- **Status:** Accepted
- **Date:** 2026-11-23
- **Amends:** [ADR-0040](0040-factory-sweeper.md) (the sweeper ran from GitHub's cron every 30
  minutes) and [ADR-0047](0047-factory-dispatcher.md) (the dispatcher's sweep ran from GitHub's
  cron every 30 minutes)

## Context

ADR-0040 promises that a factory pull request is never stuck for more than about two and a half
hours without a label, and it gets there by sweeping every 30 minutes on GitHub's `schedule`
event. Since PR #156 ([ADR-0058](0058-factory-resolves-conflicts.md)) the sweeper is also the
fallback that starts the conflict resolver. ADR-0047's dispatcher sweeps on the same kind of
schedule as the backstop for events GitHub drops.

Neither schedule holds (brianpatterson/roundtable#157):

- The sweeper (`*/30 * * * *`) ran 8 times in the 49 hours from 2026-11-21 00:55 UTC, where it
  should have run about 98 times: 00:55, 08:10, 16:20, 21:49, 02:00, 10:09, 17:59, 23:33, then
  none until this ADR, a gap of more than 3 hours at the time of writing.
- The dispatcher (`15,45 * * * *`) ran 3 times on its schedule (11-22 14:36, 20:50, 11-23 01:44).
  Its other 27 runs came from its event triggers. It is already off the top of the hour, so
  GitHub's advice to avoid `:00` doesn't help.
- PR #155 began conflicting with main around 00:44 UTC on 11-23 and no sweep ran afterwards to
  flag it.

**Cause.** Both workflows are enabled (the Actions API reports `active`), and every scheduled
workflow in this repository is late, not only these two. The nightly Backup (`17 7 * * *`) has
started between 14:07 and 16:58 UTC every day since 2026-11-13, 7 to 9½ hours late. The nightly
Security audit (`41 6 * * *`) started at 14:53 and 14:55. A `*/30` cron that GitHub starts hours
late doesn't catch up: GitHub's documentation says a `schedule` run "can be delayed during periods
of high loads" and that "some queued jobs may be dropped", and the runs we got are what's left.
The other documented reason for missing runs, disabling after 60 days without activity in a
public repository, doesn't apply: the repository gets commits daily and the workflows are active.
How sure: **high** that this is GitHub's scheduler and not our configuration, since every cron
here is late by the same hours whatever its minute. **Unknown** why this repository's delay is so
large. GitHub doesn't document a per-repository limit, and nothing we control would change it.
`infra/monitoring.tf` already gave the backup heartbeat 12 hours of grace for the same reason.

## Options considered

1. **Run the sweeps on events that already happen** (`workflow_run` after CI, Review and Deploy),
   alongside the schedule. Free, and it sweeps at the moment most stuck states begin. But most of
   the sweeper's rules are timeouts (no CI 30 minutes after a push, no review an hour after green
   CI, no fix two hours after a failure). An event starts a sweep at minute 0, which can only
   say "wait". The sweep that should notice is the one that comes later, and in a quiet hour no
   event comes. On its own this doesn't keep ADR-0040's promise.
2. **Detect a missed sweep inside GitHub** (Main health, or a check that fails when the last sweep
   is more than an hour old). Whatever runs the check has to be running, and a stalled schedule is
   exactly when nothing is. It would report hours late, through the same delayed scheduler.
3. **A runner that stays up**: a workflow that sweeps, sleeps 20 minutes and repeats, and
   re-dispatches itself before the 6-hour job limit. No new infrastructure or secret, but it holds a
   hosted runner around the clock (about 720 hours a month) for 10 seconds of work an hour. That's
   the "disproportionate burden" GitHub's terms warn about, and when the chain breaks, only
   the delayed cron restarts it.
4. **An external clock calling `workflow_dispatch` (chosen)**, with a dead man's switch outside
   GitHub. A Cloudflare Worker with a Cron Trigger fires on time and is free. Cloudflare is
   already in the stack, managed by the same OpenTofu (DNS, R2). It needs a GitHub token, which
   can expire or leak. Hosted cron services (cron-job.org and the like) would hold the same token
   outside our infrastructure code. A systemd timer on the droplet would put a GitHub token on the
   production server and stop whenever it's down.

## Decision

Option 4, with option 1's events added for the sweeper, and a heartbeat for each sweep:

- **The clock.** `infra/factory-clock.tf` deploys a Cloudflare Worker (`factory-clock/worker.js`)
  whose Cron Trigger fires at minutes 7, 27 and 47 of every hour. Each tick sends
  `workflow_dispatch` on `main` for `sweeper.yml` and `dispatcher.yml`, each regardless of whether
  the other worked. A refused dispatch fails the tick, which shows in the Worker's logs. The
  token is fine-grained: this repository only, **Actions: read and write**, nothing else. It can
  start, rerun and cancel workflow runs, and can't read code, secrets or issues. The runs it
  starts check their own rules before acting (the dispatcher re-verifies every ticket). It's a
  `secret_text` binding, set from `terraform.tfvars` into the encrypted state (ADR-0016).
- **Events.** The sweeper also runs after every CI and Review run (`workflow_run`), so a
  cancelled CI is rerun, or a conflict sent to the resolver, within seconds. The clock still
  catches the timeouts. CI → Review → sweeper is three levels of `workflow_run`, GitHub's limit.
  The dispatcher keeps the events it already had (issue closed, Deploy finished).
- **GitHub's cron stays** on both workflows as a backstop. It costs nothing, and it still
  runs every few hours if the clock stops.
- **Concurrency is unchanged.** Each workflow keeps its group (`factory-sweeper`; the dispatcher's
  `factory-dispatch`, shared with the Factory workflow's gate) with `cancel-in-progress: false`.
  Extra triggers queue behind the running sweep, and a newer waiting run replaces an older one.
  Each sweep reads the current state, so nothing is lost and two sweeps never race.
- **The dead man's switch.** Every successful sweep, whatever started it, pings its own Better
  Stack heartbeat (`.github/factory/ping-heartbeat.sh`; URLs in the `SWEEPER_HEARTBEAT_URL` and
  `DISPATCHER_HEARTBEAT_URL` secrets), as the nightly backup already does (ADR-0019). Each
  heartbeat expects a ping every hour, with 5 minutes of grace. Sweeps come every 20 minutes, so
  two ticks can go missing without an alert, and an hour without a successful sweep opens a Better Stack incident and emails the owner. That covers a dead clock,
  an expired token, an Actions outage and a sweep that keeps failing. The alert has to come from
  outside GitHub, since a check inside it runs only when GitHub runs something (option 2). A
  dry run doesn't ping, and a failed ping only warns: the missing pings raise the alarm.

The rules in `sweep-prs.sh` and `dispatch.sh` are unchanged. A sweep now comes at least every 20
minutes and up to 60 minutes late before anyone is told, so ADR-0040's promise holds: the longest
threshold (2 hours) plus 20 minutes. ADR-0047's sweep happens every 20 minutes too.

## Consequences

- Sweeps run about 72 times a day each from the clock, plus one per CI and Review run for the
  sweeper. Each takes about 10 seconds of a hosted runner. That's free in a public repository and
  much less than a runner kept up (option 3).
- New moving parts: a Worker, a Cron Trigger, two heartbeats, and a token. The Cloudflare token
  needs **Workers Scripts: Edit**. The GitHub token expires (a year at most) and must be rotated
  before it does. If it isn't, the heartbeats alert within the hour, unless events keep the
  sweeper going during a busy stretch, in which case they alert after the first quiet hour.
  Setup and rotation are in `infra/README.md`, under Factory clock.
- Until a human applies the OpenTofu change and sets the two secrets, nothing changes: the
  sweeps still run on GitHub's late cron and on events, and the ping step says no heartbeat is
  set.
- Sweeps started by the clock show the token owner as the actor in the Actions tab, with event
  `workflow_dispatch`, the same as a manual run.
- Revisit if GitHub's scheduled runs come back on time for weeks (the backup's start time shows
  it): the clock could then go, keeping the heartbeats. Also revisit if the factory starts more
  timed work, which should be one more line in `WORKFLOWS`, not another clock.
