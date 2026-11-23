import { describe, expect, it } from 'vitest';
import { failedByRejection, type InferenceRound } from './inference.js';

// The pure inference rules, with no database: the Round lifecycle's HTTP tests in rounds.test.ts
// keep one case per behaviour, and the day and order rules are pinned here.

/** A Round named `id`, pending and not set by the user unless `outcome` says otherwise. */
const round = (
  id: string,
  schedule: { startsAt?: string; dueOn?: string } = {},
  outcome: Partial<Pick<InferenceRound, 'outcome' | 'outcomeSetByUser'>> = {},
): InferenceRound => ({
  id,
  startsAt: schedule.startsAt === undefined ? null : new Date(schedule.startsAt),
  dueOn: schedule.dueOn ?? null,
  outcome: 'pending',
  outcomeSetByUser: false,
  ...outcome,
});

// Noon on 30 November, then 10:00, a take-home and 20:00 on 1 December, in New York. The evening
// Round is already 2 December in UTC.
const newYorkDay = [
  round('dayBefore', { startsAt: '2026-11-30T17:00:00Z' }),
  round('morning', { startsAt: '2026-12-01T15:00:00Z' }),
  round('takeHome', { dueOn: '2026-12-01' }),
  round('evening', { startsAt: '2026-12-02T01:00:00Z' }),
];

// 19:00 on 1 December, then 01:00 and 19:00 on 2 December, in Tokyo. The 01:00 Round is still
// 1 December in UTC.
const tokyoDay = [
  round('evening', { startsAt: '2026-12-01T10:00:00Z' }),
  round('night', { startsAt: '2026-12-01T16:00:00Z' }),
  round('nextEvening', { startsAt: '2026-12-02T10:00:00Z' }),
];

describe('the Rounds a rejection fails', () => {
  it.each<{
    name: string;
    rounds: InferenceRound[];
    timeZone: string;
    failed: string[];
  }>([
    { name: 'none, without Rounds', rounds: [], timeZone: 'UTC', failed: [] },
    {
      name: 'the latest, leaving the earlier ones',
      rounds: [
        round('later', { startsAt: '2026-12-03T17:00:00Z' }),
        round('earlier', { startsAt: '2026-12-01T17:00:00Z' }),
      ],
      timeZone: 'UTC',
      failed: ['later'],
    },
    {
      name: 'every one on the latest day, west of UTC',
      rounds: newYorkDay,
      timeZone: 'America/New_York',
      // In Round order: a take-home from the start of its due day.
      failed: ['takeHome', 'morning', 'evening'],
    },
    {
      name: 'only the one on UTC’s latest day, for the same Rounds in UTC',
      rounds: newYorkDay,
      timeZone: 'UTC',
      failed: ['evening'],
    },
    {
      name: 'every one on the latest day, east of UTC',
      rounds: tokyoDay,
      timeZone: 'Asia/Tokyo',
      failed: ['night', 'nextEvening'],
    },
    {
      name: 'only the one on UTC’s latest day, for the same Rounds in UTC',
      rounds: tokyoDay,
      timeZone: 'UTC',
      failed: ['nextEvening'],
    },
    {
      name: 'a take-home due on the latest day, by its date in any time zone',
      rounds: [
        round('takeHome', { dueOn: '2026-12-02' }),
        round('night', { startsAt: '2026-12-01T16:00:00Z' }),
      ],
      timeZone: 'Asia/Tokyo',
      failed: ['takeHome', 'night'],
    },
    {
      name: 'only the last added of the unscheduled ones, which come after the dated',
      rounds: [
        round('firstUnscheduled'),
        round('dated', { startsAt: '2026-12-01T17:00:00Z' }),
        round('lastUnscheduled'),
      ],
      timeZone: 'UTC',
      failed: ['lastUnscheduled'],
    },
    {
      name: 'the latest dated one once the unscheduled ones are set by the user',
      rounds: [
        round('dated', { startsAt: '2026-12-01T17:00:00Z' }),
        round('unscheduled', {}, { outcomeSetByUser: true }),
      ],
      timeZone: 'UTC',
      failed: ['dated'],
    },
    {
      name: 'the latest the user hasn’t set, passing over theirs, pending included',
      rounds: [
        round('earlier', { startsAt: '2026-12-01T17:00:00Z' }),
        round('setPending', { startsAt: '2026-12-03T17:00:00Z' }, { outcomeSetByUser: true }),
        round(
          'setPassed',
          { startsAt: '2026-12-03T19:00:00Z' },
          { outcome: 'passed', outcomeSetByUser: true },
        ),
      ],
      timeZone: 'UTC',
      failed: ['earlier'],
    },
    {
      name: 'only those on the latest one’s day, when the user set one on the same day',
      rounds: [
        round('earlier', { startsAt: '2026-12-01T17:00:00Z' }),
        round('morning', { startsAt: '2026-12-03T09:00:00Z' }),
        round(
          'setFailed',
          { startsAt: '2026-12-03T19:00:00Z' },
          {
            outcome: 'failed',
            outcomeSetByUser: true,
          },
        ),
      ],
      timeZone: 'UTC',
      failed: ['morning'],
    },
    {
      name: 'none, when every Round already has an Outcome',
      rounds: [
        round('passed', { startsAt: '2026-12-01T17:00:00Z' }, { outcome: 'passed' }),
        round('unknown', { startsAt: '2026-12-03T17:00:00Z' }, { outcome: 'unknown' }),
      ],
      timeZone: 'UTC',
      failed: [],
    },
  ])('fails $name', ({ rounds, timeZone, failed }) => {
    expect(failedByRejection(rounds, timeZone)).toEqual(failed);
  });
});
