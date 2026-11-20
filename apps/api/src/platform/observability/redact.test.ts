import { describe, expect, it } from 'vitest';
import { describeError, describeParams, postgresFields } from './redact.js';

// The redactions themselves are tested where they're used (logging.test.ts, error-tracking.test.ts),
// against real failures. These pin the details those tests don't reach (ADR-0027's API spike).

/** An error carrying Postgres's diagnostic fields, as both drivers raise them. */
const postgresError = (message: string, code: string) =>
  Object.assign(new Error(message), { code, severity: 'ERROR' });

describe('describeParams', () => {
  it('names the kind of every parameter, never its value', () => {
    const params = [
      null,
      undefined,
      crypto.randomUUID(),
      'abc',
      42,
      true,
      new Date(),
      [1, 2],
      { secret: 'value' },
    ];

    expect(describeParams(params)).toBe(
      '<redacted: null, undefined, uuid, string(3), number, boolean, date, array(2), object>',
    );
  });

  it('says when there were none', () => {
    expect(describeParams([])).toBe('<redacted: none>');
  });
});

describe('describeError', () => {
  it('redacts a failed query in a message even without Drizzle params to describe', () => {
    const err = new Error('Failed query: select 1 where token = $1\nparams: secret-token');

    expect(describeError(err).message).toBe(
      'Failed query: select 1 where token = $1\nparams: <redacted>',
    );
  });

  it("describes only Drizzle's params, not a params property on any other error", () => {
    const err = Object.assign(new Error('Failed query: select $1\nparams: secret-token'), {
      params: ['secret-token'],
    });

    expect(describeError(err).message).toBe('Failed query: select $1\nparams: <redacted>');
  });

  it('builds the stack from the name and message when the error has none', () => {
    const err = new TypeError('Failed query: select $1\nparams: secret-token');
    err.stack = undefined;

    expect(describeError(err).stack).toBe('TypeError: Failed query: select $1\nparams: <redacted>');
  });

  it('removes quoted values only from data exceptions (SQLSTATE class 22)', () => {
    const dataException = postgresError('invalid input syntax for type uuid: "secret"', '22P02');
    const constraint = postgresError('violates check constraint "status_check"', '23514');

    expect(describeError(dataException).message).toBe(
      'invalid input syntax for type uuid: "<redacted>"',
    );
    expect(describeError(constraint).message).toBe('violates check constraint "status_check"');
  });
});

describe('postgresFields', () => {
  it('reads an error with a five-character SQLSTATE', () => {
    expect(postgresFields(postgresError('failed', '23505'))).toEqual({
      code: '23505',
      severity: 'ERROR',
    });
  });

  it('ignores an error whose code is not exactly a SQLSTATE', () => {
    for (const code of ['X23505', '23505X', 'ECONNREFUSED']) {
      expect(postgresFields(postgresError('failed', code))).toBeUndefined();
    }
  });
});
