// The factory's clock (ADR-0060). GitHub starts this repository's scheduled workflows hours late
// and drops the runs that pile up meanwhile, so a 30-minute cron ran every 6 to 8 hours. A
// Cloudflare Cron Trigger fires on time; on each tick this starts the factory's two sweeps
// through workflow_dispatch, with a fine-grained token that can only do that and read Actions.
// Deployed by infra/factory-clock.tf; tested by worker.test.js (node --test, in CI's infra job).

/** The workflows each tick starts, on main. Each must have a `workflow_dispatch` trigger. */
export const WORKFLOWS = ['sweeper.yml', 'dispatcher.yml'];

/**
 * Starts every workflow in WORKFLOWS, each whether or not another failed, and throws naming
 * the ones GitHub refused, so the tick shows as failed in the Worker's logs. A missed tick is
 * also caught by the sweeps' heartbeats in Better Stack, which alert after an hour.
 */
export async function dispatchAll(env, fetchImpl = fetch) {
  const results = await Promise.allSettled(
    WORKFLOWS.map(async (workflow) => {
      const url = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${workflow}/dispatches`;

      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          'Content-Type': 'application/json',
          // GitHub's API refuses requests without one.
          'User-Agent': 'roundtable-factory-clock',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ ref: 'main' }),
      });

      if (!response.ok) throw new Error(`${workflow}: HTTP ${response.status}`);

      return workflow;
    }),
  );

  const failures = results
    .filter((result) => result.status === 'rejected')
    .map((result) => String(result.reason?.message ?? result.reason));

  if (failures.length > 0) {
    throw new Error(`workflow_dispatch failed for ${failures.join('; ')}`);
  }
}

export default {
  async scheduled(_controller, env) {
    await dispatchAll(env);
  },
};
