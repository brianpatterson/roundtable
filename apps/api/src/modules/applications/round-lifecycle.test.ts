import { describe, expect, it } from 'vitest';
import { APPLICATION_STATUSES, type ApplicationStatus } from '@roundtable/contract';
import { movesToInterviewing } from './round-lifecycle.js';

// The Round lifecycle's pure status rule, with no database: the HTTP tests in rounds.test.ts keep
// one case per behaviour.

describe('the status a new Round moves its Application to', () => {
  it('moves an applied Application to interviewing with its first Round', () => {
    expect(movesToInterviewing('applied', 0)).toBe(true);
  });

  it.each(APPLICATION_STATUSES.filter((status) => status !== 'applied'))(
    'leaves a %s Application alone',
    (status: ApplicationStatus) => {
      expect(movesToInterviewing(status, 0)).toBe(false);
    },
  );

  it.each([1, 2])('leaves an applied Application with %i Rounds alone', (earlier) => {
    expect(movesToInterviewing('applied', earlier)).toBe(false);
  });
});
