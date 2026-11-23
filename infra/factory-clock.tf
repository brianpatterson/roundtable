# The factory's clock and its dead man's switches (ADR-0060).
#
# GitHub starts this repository's scheduled workflows 7 to 9 hours late and drops the runs that
# pile up meanwhile: the sweeper's `*/30` cron ran 8 times in 49 hours. A Cloudflare Cron Trigger
# fires on time, so this Worker starts the sweeper and the dispatcher every 20 minutes through
# `workflow_dispatch`. Each sweep pings its Better Stack heartbeat when it succeeds; an hour with
# no successful sweep, from any cause (the token expired, the Worker failed, GitHub Actions is
# down, the sweep itself keeps failing), opens an incident and emails the account owner.

resource "cloudflare_workers_script" "factory_clock" {
  account_id         = var.cloudflare_account_id
  script_name        = "roundtable-factory-clock"
  content            = file("${path.module}/factory-clock/worker.js")
  main_module        = "worker.js"
  compatibility_date = "2026-11-01"

  bindings = [
    {
      name = "GITHUB_REPOSITORY"
      type = "plain_text"
      text = var.github_repository
    },
    {
      # A fine-grained token: this repository only, Actions read and write (see README).
      name = "GITHUB_TOKEN"
      type = "secret_text"
      text = var.github_factory_clock_token
    },
  ]

  # Keeps each tick's result (and the error naming a refused workflow) in the Worker's logs.
  observability = {
    enabled = true
  }
}

resource "cloudflare_workers_cron_trigger" "factory_clock" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_workers_script.factory_clock.script_name
  # Every 20 minutes, off GitHub's busy top of the hour. Cron Triggers run in UTC.
  schedules = [{ cron = "7,27,47 * * * *" }]
}

# A sweep pings these after it succeeds, whatever started it (the clock, an event, GitHub's own
# late cron). Expected every 20 minutes; the grace lets two ticks go missing before alerting, so
# an incident opens when an hour passes without a successful sweep.
resource "betteruptime_heartbeat" "sweeper" {
  name   = "Factory sweeper"
  period = 1200
  grace  = 2400
  email  = true
}

resource "betteruptime_heartbeat" "dispatcher" {
  name   = "Dispatcher"
  period = 1200
  grace  = 2400
  email  = true
}
