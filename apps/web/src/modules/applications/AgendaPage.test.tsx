import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestRouter, TestRouterProvider } from '../../shared/testing/router';
import { AgendaPage } from './AgendaPage';

// The page calls the real typed client; only the server behind `fetch` is a stand-in, answering
// the Agenda the way the API does (ADR-0070). Tests run in Los Angeles (vite.config.ts), where
// it's 10:00 on Tuesday, Dec 1, 2026.
const NOW = new Date('2026-12-01T10:00:00-08:00');

let nextId = 1;

/** A Round on the Agenda, as the API sends it. */
const agendaRound = (
  company: string,
  interviewType: string,
  when: { startsAt?: string; dueOn?: string } = {},
) => {
  const id = String(nextId++).padStart(12, '0');

  return {
    id: `00000000-0000-4000-8000-${id}`,
    applicationId: `00000000-0000-4000-9000-${id}`,
    interviewType,
    tags: [],
    startsAt: when.startsAt ?? null,
    durationMinutes: null,
    dueOn: when.dueOn ?? null,
    selfRating: null,
    ratingNote: null,
    outcome: 'pending',
    outcomeSetByUser: false,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    company,
    jobTitle: 'Engineer',
  };
};

/** The Agenda the server answers with. */
let answer: ReturnType<typeof agendaRound>[];

/** When set, the server fails with this status instead. */
let failWith: number | undefined;

/** The query of every Agenda request. */
let queries: URLSearchParams[];

function fakeServer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(new Request(input, init).url);

  if (url.pathname !== '/api/agenda') return Promise.resolve(new Response(null, { status: 404 }));

  queries.push(url.searchParams);

  return Promise.resolve(
    failWith ? new Response(null, { status: failWith }) : Response.json(answer),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: NOW });
  answer = [];
  failWith = undefined;
  queries = [];
  vi.stubGlobal('fetch', fakeServer);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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
  it('groups the Rounds by day in the API’s order, each with its time, time left and type', async () => {
    answer = [
      // Today: a take-home before an interview, as the server ordered them.
      agendaRound('Globex', 'take_home', { dueOn: '2026-12-01' }),
      agendaRound('Acme', 'coding', { startsAt: '2026-12-01T12:15:00-08:00' }),
      agendaRound('Initech', 'recruiter_screen', { startsAt: '2026-12-01T09:00:00-08:00' }),
      agendaRound('Umbrella', 'system_design', { startsAt: '2026-12-02T09:00:00-08:00' }),
      agendaRound('Hooli', 'behavioral', { startsAt: '2026-12-04T23:00:00-08:00' }),
      agendaRound('Stark', 'take_home', { dueOn: '2026-12-04' }),
      agendaRound('Wayne', 'hiring_manager'),
    ];
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Today' })).toBeDefined();

    const friday = new Date(2026, 11, 4).toLocaleDateString(undefined, { dateStyle: 'full' });

    expect(
      within(screen.getByRole('region', { name: 'Agenda' }))
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(['Today', 'Tomorrow', friday, 'Not scheduled yet']);

    expect(rowsUnder('Today')).toEqual([
      'DueDue todayGlobex – EngineerTake-home',
      `${timeOf('2026-12-01T12:15:00-08:00')}in 2 h 15 minAcme – EngineerCoding`,
      `${timeOf('2026-12-01T09:00:00-08:00')}StartedInitech – EngineerRecruiter screen`,
    ]);
    expect(rowsUnder('Tomorrow')).toEqual([
      `${timeOf('2026-12-02T09:00:00-08:00')}TomorrowUmbrella – EngineerSystem design`,
    ]);
    expect(rowsUnder(friday)).toEqual([
      `${timeOf('2026-12-04T23:00:00-08:00')}in 3 daysHooli – EngineerBehavioral`,
      'DueDue in 3 daysStark – EngineerTake-home',
    ]);
    expect(rowsUnder('Not scheduled yet')).toEqual(['Wayne – EngineerHiring manager']);
  });

  it('links each Round to its application', async () => {
    const acme = agendaRound('Acme', 'coding', { startsAt: '2026-12-01T12:15:00-08:00' });

    answer = [acme];
    renderPage();

    const link = await screen.findByRole('link', { name: 'Acme – Engineer' });

    expect(link.getAttribute('href')).toBe(`/applications/${acme.applicationId}`);
  });

  it('asks for the Agenda in the user’s time zone', async () => {
    renderPage();

    await screen.findByText(/Nothing coming up/);
    expect(queries.map((query) => query.get('timeZone'))).toEqual(['America/Los_Angeles']);
  });

  it('counts the time left down every minute while the page is open', async () => {
    answer = [agendaRound('Acme', 'coding', { startsAt: '2026-12-01T10:02:00-08:00' })];
    renderPage();

    expect(await screen.findByText('in 2 min')).toBeDefined();

    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText('in 1 min')).toBeDefined();

    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText('Started')).toBeDefined();
    // Without asking the server again.
    expect(queries).toHaveLength(1);
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
    failWith = 500;
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
