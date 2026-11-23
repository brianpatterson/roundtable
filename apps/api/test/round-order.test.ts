// Round order (GLOSSARY.md), at the contract's interface: the order inference and the web's list
// both take from `inRoundOrder`, and the user's day from `roundDay`. Pure, so no database here.
import { describe, expect, it } from 'vitest';
import { inRoundOrder, roundDay, type OrderedRound } from '@roundtable/contract';

interface Named extends OrderedRound {
  readonly name: string;
}

const at = (name: string, startsAt: string): Named => ({
  name,
  startsAt: new Date(startsAt),
  dueOn: null,
});

const due = (name: string, dueOn: string): Named => ({ name, startsAt: null, dueOn });

const unscheduled = (name: string): Named => ({ name, startsAt: null, dueOn: null });

const names = (rounds: readonly Named[]) => rounds.map(({ name }) => name);

describe('inRoundOrder', () => {
  it('puts an interview the evening before ahead of a take-home, west of UTC', () => {
    // 20:00 on 30 November in Los Angeles is 04:00 on 1 December in UTC.
    const rounds = [due('take-home', '2026-12-01'), at('interview', '2026-12-01T04:00:00Z')];

    expect(names(inRoundOrder(rounds, 'America/Los_Angeles'))).toEqual(['interview', 'take-home']);
  });

  it('puts a take-home ahead of an interview that morning, east of UTC', () => {
    // 08:00 on 1 December in Tokyo is 23:00 on 30 November in UTC.
    const rounds = [at('interview', '2026-11-30T23:00:00Z'), due('take-home', '2026-12-01')];

    expect(names(inRoundOrder(rounds, 'Asia/Tokyo'))).toEqual(['take-home', 'interview']);
  });

  it('orders a take-home by the start of its due day in UTC when the zone is UTC', () => {
    const rounds = [at('interview', '2026-12-01T04:00:00Z'), due('take-home', '2026-12-01')];

    expect(names(inRoundOrder(rounds, 'UTC'))).toEqual(['take-home', 'interview']);
  });

  it('lists dated Rounds by date, then unscheduled ones in the order given', () => {
    const rounds = [
      unscheduled('first unscheduled'),
      at('later', '2026-12-03T15:00:00Z'),
      due('take-home', '2026-12-02'),
      unscheduled('second unscheduled'),
      at('earliest', '2026-12-01T15:00:00Z'),
    ];

    expect(names(inRoundOrder(rounds, 'UTC'))).toEqual([
      'earliest',
      'take-home',
      'later',
      'first unscheduled',
      'second unscheduled',
    ]);
  });

  it('keeps Rounds at the same time in the order given', () => {
    const rounds = [
      at('first', '2026-12-01T15:00:00Z'),
      at('second', '2026-12-01T15:00:00Z'),
      due('third', '2026-12-01'),
      due('fourth', '2026-12-01'),
    ];

    expect(names(inRoundOrder(rounds, 'UTC'))).toEqual(['third', 'fourth', 'first', 'second']);
  });

  it('returns a sorted copy, leaving the Rounds given as they were', () => {
    const rounds = [at('later', '2026-12-02T15:00:00Z'), at('earlier', '2026-12-01T15:00:00Z')];
    const sorted = inRoundOrder(rounds, 'UTC');

    expect(names(sorted)).toEqual(['earlier', 'later']);
    expect(names(rounds)).toEqual(['later', 'earlier']);
    expect(sorted[0]).toBe(rounds[1]);
  });

  it('finds the start of a due day across a daylight saving change', () => {
    // New York leaves daylight saving at 02:00 on 1 November 2026, so that day starts at 04:00
    // UTC (UTC−4), not 05:00: an interview at 00:30 that night comes after the take-home.
    const rounds = [at('interview', '2026-11-01T04:30:00Z'), due('take-home', '2026-11-01')];

    expect(names(inRoundOrder(rounds, 'America/New_York'))).toEqual(['take-home', 'interview']);
  });
});

describe('roundDay', () => {
  it('is the day a start falls on in the time zone', () => {
    const round = at('interview', '2026-11-30T23:00:00Z');

    expect(roundDay(round, 'UTC')).toBe('2026-11-30');
    expect(roundDay(round, 'Asia/Tokyo')).toBe('2026-12-01');
    expect(roundDay(round, 'America/Los_Angeles')).toBe('2026-11-30');
  });

  it('is a take-home’s due date, wherever the user is', () => {
    expect(roundDay(due('take-home', '2026-12-01'), 'Asia/Tokyo')).toBe('2026-12-01');
    expect(roundDay(due('take-home', '2026-12-01'), 'America/Los_Angeles')).toBe('2026-12-01');
  });

  it('pads the year, month and day', () => {
    expect(roundDay(at('interview', '0999-01-02T12:00:00Z'), 'UTC')).toBe('0999-01-02');
  });

  it('is none for a Round not scheduled yet', () => {
    expect(roundDay(unscheduled('call'), 'UTC')).toBeNull();
  });
});
