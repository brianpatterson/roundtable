// The App's promise: everything it opens, it closes. Both database pools (Effect's for the
// modules, the Promise one for Better Auth) are scoped to the App, so stopping it must leave no
// connection behind. A leak used to show up only as a test run that never exited.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redacted } from 'effect';
import pg from 'pg';
import { APPLICATION_NAME } from '../src/platform/database/promise.js';
import { env, setupTestApp, signUp } from './helpers.js';

describe('the App lifecycle', () => {
  // Counts from outside the App, under a name of its own.
  const observer = new pg.Client({
    connectionString: Redacted.value(env.DATABASE_URL),
    application_name: 'roundtable-lifecycle-test',
  });

  const appConnections = async () => {
    const { rows } = await observer.query<{ count: number }>(
      `select count(*)::int as count from pg_stat_activity
       where datname = current_database() and application_name = $1`,
      [APPLICATION_NAME],
    );

    return rows[0]!.count;
  };

  // A closed connection can take a moment to leave pg_stat_activity.
  const settledCount = async (expected: number) => {
    let count = await appConnections();

    for (let attempt = 0; attempt < 20 && count !== expected; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      count = await appConnections();
    }

    return count;
  };

  beforeAll(() => observer.connect());
  afterAll(() => observer.end());

  it('closes both of its database pools when it stops', async () => {
    const before = await appConnections();
    const t = setupTestApp();

    await t.migrate();
    await t.reset();
    // Sign-up runs through Better Auth (the Promise pool) and the email limits (the Effect pool).
    await signUp(t);
    expect(await t.inject({ method: 'GET', url: '/api/health' })).toMatchObject({
      statusCode: 200,
    });

    expect(await appConnections()).toBeGreaterThan(before);

    await t.close();

    expect(await settledCount(before)).toBe(before);
  });
});
