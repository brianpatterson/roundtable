// The health check deploys and uptime monitors use (server.ts): the API answers even when the
// database doesn't, and says which.
import { afterAll, describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import { Health } from '@roundtable/contract';
import { setupTestApp } from './helpers.js';

const healthOf = async (t: ReturnType<typeof setupTestApp>) => {
  const res = await t.inject({ method: 'GET', url: '/api/health' });

  expect(res.statusCode).toBe(200);

  return Schema.decodeUnknownSync(Health)(res.json());
};

describe('the health check', () => {
  const up = setupTestApp();
  const down = setupTestApp({ databaseUrl: 'postgres://app:app@localhost:1/nowhere' });

  afterAll(async () => {
    await up.close();
    await down.close();
  });

  it('reports the database up', async () => {
    expect(await healthOf(up)).toMatchObject({ ok: true, db: 'up' });
  });

  it('still answers with the database down, and says so', async () => {
    expect(await healthOf(down)).toMatchObject({ ok: true, db: 'down' });
  });
});
