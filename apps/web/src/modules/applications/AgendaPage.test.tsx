import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import type { InterviewType } from '@roundtable/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serverError, setUpFakeApi } from '../../shared/testing/fake-api';
import { createTestRouter, TestRouterProvider } from '../../shared/testing/router';
import { AgendaPage } from './AgendaPage';

// The page calls the real typed client, answered by the in-memory API, which answers the Agenda
// by the contract's rules (ADR-0070). Tests run in Los Angeles (vite.config.ts), where it's 10:00
// on Tuesday, Dec 1, 2026.
const fake = setUpFakeApi();

const NOW = new Date('2026-12-01T10:00:00-08:00');

/** One application at `company`, with one Round of `interviewType`, scheduled as `when` says. */
const seedRound = (
  company: string,
  interviewType: InterviewType,
  when: { startsAt?: string; dueOn?: string } = {},
) => {
  const { id } = fake.seedApplication({ company, jobTitle: 'Engineer' });

  return fake.seedRound(id, {
    interviewType,
    startsAt: when.startsAt === undefined ? null : new Date(when.startsAt),
    dueOn: when.dueOn ?? null,
  });
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

/** How many times the page asked for the Agenda. */
const agendaRequests = () => fake.received('agenda.list');

const renderPage = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={queryClient}>
      <TestRouterProvider router={createTestRouter(<AgendaPage />)} />
    </QueryClientProvider>,
  );
};

/** Each row of a day's group, as the text a user reads, in order. */
const rowsUnder = (heading: string) =>
  within(screen.getByRole('region', { name: heading }))
    .getAllByRole('listitem')
    .map((row) => row.textContent);

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { timeStyle: 'short' });

describe('AgendaPage', () => {
  it('groups the Rounds by day in Agenda order, each with its time, time left and type', async () => {
    seedRound('Acme', 'coding', { startsAt: '2026-12-01T12:15:00-08:00' });
    seedRound('Wayne', 'hiring_manager');
    seedRound('Hooli', 'behavioral', { startsAt: '2026-12-04T23:00:00-08:00' });
    seedRound('Initech', 'recruiter_screen', { startsAt: '2026-12-01T09:00:00-08:00' });
    seedRound('Globex', 'take_home', { dueOn: '2026-12-01' });
    seedRound('Umbrella', 'system_design', { startsAt: '2026-12-02T09:00:00-08:00' });
    seedRound('Stark', 'take_home', { dueOn: '2026-12-04' });
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Today' })).toBeDefined();

    const friday = new Date(2026, 11, 4).toLocaleDateString(undefined, { dateStyle: 'full' });

    expect(
      within(screen.getByRole('region', { name: 'Agenda' }))
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(['Today', 'Tomorrow', friday, 'Not scheduled yet']);

    // A take-home due today sorts from the start of the day, before today's interviews.
    expect(rowsUnder('Today')).toEqual([
      'DueDue todayGlobex – EngineerTake-home',
      `${timeOf('2026-12-01T09:00:00-08:00')}StartedInitech – EngineerRecruiter screen`,
      `${timeOf('2026-12-01T12:15:00-08:00')}in 2 h 15 minAcme – EngineerCoding`,
    ]);
    expect(rowsUnder('Tomorrow')).toEqual([
      `${timeOf('2026-12-02T09:00:00-08:00')}TomorrowUmbrella – EngineerSystem design`,
    ]);
    expect(rowsUnder(friday)).toEqual([
      'DueDue in 3 daysStark – EngineerTake-home',
      `${timeOf('2026-12-04T23:00:00-08:00')}in 3 daysHooli – EngineerBehavioral`,
    ]);
    expect(rowsUnder('Not scheduled yet')).toEqual(['Wayne – EngineerHiring manager']);
  });

  it('links each Round to its application', async () => {
    const acme = seedRound('Acme', 'coding', { startsAt: '2026-12-01T12:15:00-08:00' });

    renderPage();

    const link = await screen.findByRole('link', { name: 'Acme – Engineer' });

    expect(link.getAttribute('href')).toBe(`/applications/${acme.applicationId}`);
  });

  it('shows each Round’s Prep progress, complete in words, and none without prep tasks', async () => {
    const done = new Date('2026-11-20T00:00:00Z');

    const task = (n: number, completedAt: Date | null) => ({
      id: `00000000-0000-4000-8000-${String(1000 + n).padStart(12, '0')}`,
      title: `Task ${n}`,
      skillId: null,
      completedAt,
    });

    fake.seedRound(fake.seedApplication({ company: 'Acme', jobTitle: 'Engineer' }).id, {
      interviewType: 'coding',
      prepTasks: [task(1, done), task(2, null), task(3, done), task(4, null), task(5, null)],
    });
    fake.seedRound(fake.seedApplication({ company: 'Globex', jobTitle: 'Engineer' }).id, {
      interviewType: 'behavioral',
      prepTasks: [task(6, done), task(7, done)],
    });
    seedRound('Hooli', 'system_design');
    renderPage();

    await screen.findByRole('link', { name: 'Acme – Engineer' });

    expect(rowsUnder('Not scheduled yet')).toEqual([
      'Acme – EngineerCodingPrep 2 of 5 done',
      'Globex – EngineerBehavioral✓ Prep done',
      'Hooli – EngineerSystem design',
    ]);
    expect(screen.queryAllByText(/Prep/)).toHaveLength(2);
  });

  it('asks for the Agenda in the user’s time zone', async () => {
    renderPage();

    await screen.findByText(/Nothing coming up/);
    expect(agendaRequests()).toEqual([{ timeZone: 'America/Los_Angeles' }]);
  });

  it('counts the time left down every minute while the page is open', async () => {
    seedRound('Acme', 'coding', { startsAt: '2026-12-01T10:02:00-08:00' });
    renderPage();

    expect(await screen.findByText('in 2 min')).toBeDefined();

    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText('in 1 min')).toBeDefined();

    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText('Started')).toBeDefined();
    // Without asking the server again.
    expect(agendaRequests()).toHaveLength(1);
  });

  it('says when nothing is coming up, with a link to the applications', async () => {
    renderPage();

    expect(
      await screen.findByText('Nothing coming up. Rounds you add to an application show here.', {
        exact: false,
      }),
    ).toBeDefined();
    expect(screen.getByRole('link', { name: 'Go to my applications' }).getAttribute('href')).toBe(
      '/applications',
    );
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('shows a failure as an error', async () => {
    fake.on('agenda.list', serverError);
    renderPage();

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Something went wrong. Please try again.',
    );
    expect(screen.queryByText(/Nothing coming up/)).toBeNull();
  });

  it('shows loading until the server answers', async () => {
    renderPage();

    expect(await screen.findByText('Loading…')).toBeDefined();
    await screen.findByText(/Nothing coming up/);
    expect(screen.queryByText('Loading…')).toBeNull();
  });
});
