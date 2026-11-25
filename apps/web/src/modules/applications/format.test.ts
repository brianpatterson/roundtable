import { describe, expect, it } from 'vitest';
import { agendaTime, byDay, dayHeading, timeLeft } from './format';

// The Agenda's rules (ADR-0070), at a fixed moment in a fixed zone. Tokyo is UTC+9 all year, so
// its days differ from UTC's: 23:30 on Dec 1 in Tokyo is still Dec 1 at 14:30 UTC.
const TOKYO = 'Asia/Tokyo';
const tokyo = (iso: string) => new Date(`${iso}+09:00`);

const NOW = tokyo('2026-12-01T10:00:00');

const scheduled = (iso: string) => ({ startsAt: tokyo(iso), dueOn: null });
const takeHome = (dueOn: string) => ({ startsAt: null, dueOn });
const unscheduled = { startsAt: null, dueOn: null };

describe('timeLeft', () => {
  it.each([
    ['2026-12-01T12:15:00', 'in 2 h 15 min'],
    ['2026-12-01T10:40:00', 'in 40 min'],
    ['2026-12-01T12:00:00', 'in 2 h'],
    ['2026-12-01T10:00:30', 'in 1 min'],
  ])('counts down a Round later today: %s is %s', (startsAt, expected) => {
    expect(timeLeft(scheduled(startsAt), NOW, TOKYO)).toBe(expected);
  });

  it.each([['2026-12-01T10:00:00'], ['2026-12-01T09:00:00'], ['2026-11-30T09:00:00']])(
    'says a Round that has begun, %s, has started',
    (startsAt) => {
      expect(timeLeft(scheduled(startsAt), NOW, TOKYO)).toBe('Started');
    },
  );

  it('counts later days in calendar days, not 24-hour periods', () => {
    const lateTonight = tokyo('2026-12-01T23:30:00');

    // Under an hour away, but tomorrow.
    expect(timeLeft(scheduled('2026-12-02T00:15:00'), lateTonight, TOKYO)).toBe('Tomorrow');
    // 33 hours away is still tomorrow.
    expect(timeLeft(scheduled('2026-12-02T19:00:00'), NOW, TOKYO)).toBe('Tomorrow');
    // Under 48 hours away, but two days on.
    expect(timeLeft(scheduled('2026-12-03T08:00:00'), NOW, TOKYO)).toBe('in 2 days');
    expect(timeLeft(scheduled('2026-12-04T23:00:00'), NOW, TOKYO)).toBe('in 3 days');
  });

  it('reads the day in the user’s time zone', () => {
    // 2026-12-02 at 01:00 in Tokyo is still Dec 1 in UTC.
    const round = scheduled('2026-12-02T01:00:00');

    expect(timeLeft(round, NOW, TOKYO)).toBe('Tomorrow');
    expect(timeLeft(round, NOW, 'UTC')).toBe('in 15 h');
  });

  it.each([
    ['2026-12-01', 'Due today'],
    ['2026-12-02', 'Due tomorrow'],
    ['2026-12-04', 'Due in 3 days'],
    ['2026-11-30', 'Past due'],
  ])('counts a take-home due %s as %s', (dueOn, expected) => {
    expect(timeLeft(takeHome(dueOn), NOW, TOKYO)).toBe(expected);
  });

  it('has nothing for a Round not scheduled yet', () => {
    expect(timeLeft(unscheduled, NOW, TOKYO)).toBeNull();
  });
});

describe('dayHeading', () => {
  it('names today and tomorrow, in the user’s time zone', () => {
    expect(dayHeading('2026-12-01', NOW, TOKYO)).toBe('Today');
    expect(dayHeading('2026-12-02', NOW, TOKYO)).toBe('Tomorrow');
    // Still Nov 30 in Los Angeles.
    expect(dayHeading('2026-12-01', NOW, 'America/Los_Angeles')).toBe('Tomorrow');
  });

  it('gives the date of a later day, unshifted by the time zone', () => {
    expect(dayHeading('2026-12-04', NOW, TOKYO)).toBe(
      new Date(2026, 11, 4).toLocaleDateString(undefined, { dateStyle: 'full' }),
    );
  });

  it('heads Rounds with no day "Not scheduled yet"', () => {
    expect(dayHeading(null, NOW, TOKYO)).toBe('Not scheduled yet');
  });
});

describe('agendaTime', () => {
  it('shows a scheduled Round’s start, a take-home as due, and nothing without a date', () => {
    const startsAt = new Date('2026-12-01T17:30:00Z');

    expect(agendaTime({ startsAt, dueOn: null })).toBe(
      startsAt.toLocaleTimeString(undefined, { timeStyle: 'short' }),
    );
    expect(agendaTime(takeHome('2026-12-01'))).toBe('Due');
    expect(agendaTime(unscheduled)).toBeNull();
  });
});

describe('byDay', () => {
  it('groups Rounds by their day in the order given, undated ones together', () => {
    const a = { id: 'a', ...scheduled('2026-12-01T12:00:00') };
    const b = { id: 'b', ...takeHome('2026-12-01') };
    const c = { id: 'c', ...scheduled('2026-12-03T09:00:00') };
    const d = { id: 'd', ...unscheduled };
    const e = { id: 'e', ...unscheduled };

    expect(byDay([a, b, c, d, e], TOKYO)).toEqual([
      { day: '2026-12-01', rounds: [a, b] },
      { day: '2026-12-03', rounds: [c] },
      { day: null, rounds: [d, e] },
    ]);
  });

  it('reads each Round’s day in the user’s time zone', () => {
    // 01:00 on Dec 2 in Tokyo is Dec 1 in UTC.
    const round = scheduled('2026-12-02T01:00:00');

    expect(byDay([round], TOKYO)).toEqual([{ day: '2026-12-02', rounds: [round] }]);
    expect(byDay([round], 'UTC')).toEqual([{ day: '2026-12-01', rounds: [round] }]);
  });

  it('has no days without Rounds', () => {
    expect(byDay([], TOKYO)).toEqual([]);
  });
});
