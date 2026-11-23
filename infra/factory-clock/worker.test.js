// What the factory's clock sends GitHub on each tick (ADR-0060). Run with `node --test` from
// infra/factory-clock (CI's infra job does).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import worker, { WORKFLOWS, dispatchAll } from './worker.js';

const env = { GITHUB_REPOSITORY: 'owner/repo', GITHUB_TOKEN: 'test-token' };

/** A stand-in fetch that records each request and answers with `statusFor(url)`. */
function recorder(statusFor = () => 204) {
  const calls = [];

  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const status = statusFor(url);

    if (status instanceof Error) throw status;

    return new Response(null, { status });
  };

  return { calls, fetchImpl };
}

const dispatchUrl = (workflow) =>
  `https://api.github.com/repos/owner/repo/actions/workflows/${workflow}/dispatches`;

test('starts the sweeper and the dispatcher on main', async () => {
  const { calls, fetchImpl } = recorder();

  await dispatchAll(env, fetchImpl);

  assert.deepEqual(
    calls.map((call) => call.url),
    [dispatchUrl('sweeper.yml'), dispatchUrl('dispatcher.yml')],
  );

  for (const { init } of calls) {
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { ref: 'main' });
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    assert.equal(init.headers.Accept, 'application/vnd.github+json');
    assert.equal(init.headers['X-GitHub-Api-Version'], '2022-11-28');
    assert.ok(init.headers['User-Agent'], 'GitHub refuses requests without a User-Agent');
  }
});

test('the scheduled handler dispatches through the global fetch', async (t) => {
  const { calls, fetchImpl } = recorder();

  t.mock.method(globalThis, 'fetch', fetchImpl);

  await worker.scheduled({}, env);

  assert.equal(calls.length, WORKFLOWS.length);
});

test('still starts the other workflow when GitHub refuses one, then fails naming it', async () => {
  const { calls, fetchImpl } = recorder((url) => (url.includes('sweeper') ? 401 : 204));

  await assert.rejects(dispatchAll(env, fetchImpl), (error) => {
    assert.match(error.message, /sweeper\.yml: HTTP 401/);
    assert.doesNotMatch(error.message, /dispatcher/);

    return true;
  });
  assert.equal(calls.length, 2);
});

test('fails naming both when both fail, one on the network', async () => {
  const { fetchImpl } = recorder((url) =>
    url.includes('sweeper') ? new Error('network down') : 404,
  );

  await assert.rejects(dispatchAll(env, fetchImpl), (error) => {
    assert.match(error.message, /network down/);
    assert.match(error.message, /dispatcher\.yml: HTTP 404/);

    return true;
  });
});

test('every workflow it starts can be started by workflow_dispatch', () => {
  for (const workflow of WORKFLOWS) {
    const yaml = readFileSync(
      new URL(`../../.github/workflows/${workflow}`, import.meta.url),
      'utf8',
    );

    assert.match(yaml, /^ {2}workflow_dispatch:/m, `${workflow} has no workflow_dispatch trigger`);
  }
});
