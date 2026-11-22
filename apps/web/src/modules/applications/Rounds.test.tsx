import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestRouter, TestRouterProvider } from '../../shared/testing/router';
import { ApplicationPage } from './ApplicationPage';

// The page calls the real typed client; only the server behind `fetch` is a stand-in, keeping one
// application and its Rounds the way the API does.
const ACME_ID = '00000000-0000-4000-8000-000000000001';
const ROUNDS_PATH = `/api/applications/${ACME_ID}/rounds`;

const TIMESTAMP = '2026-11-01T00:00:00.000Z';

interface Schedule {
  startsAt: string | null;
  durationMinutes: number | null;
  dueOn: string | null;
}

interface StoredRound extends Schedule {
  id: string;
  applicationId: string;
  interviewType: string;
  createdAt: string;
  updatedAt: string;
}

const NOT_SCHEDULED: Schedule = { startsAt: null, durationMinutes: null, dueOn: null };

let status: string;
let stored: StoredRound[];
let nextRound: number;

/** What the server answers a request to add or delete a Round with, unless it's the default. */
let failWrites: number | undefined;

/** The bodies the page sent to add Rounds. */
let added: unknown[];

/** The bodies the page sent to change a Round's schedule. */
let scheduled: unknown[];

const roundId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const notFound = (tag: string) => Response.json({ _tag: tag }, { status: 404 });

async function fakeServer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const { pathname } = new URL(request.url);

  if (request.method === 'GET' && pathname === `/api/applications/${ACME_ID}`) {
    return Response.json({
      id: ACME_ID,
      company: 'Acme',
      jobTitle: 'Engineer',
      jobUrl: null,
      status,
      appliedAt: TIMESTAMP,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });
  }

  if (request.method === 'GET' && pathname === ROUNDS_PATH) return Response.json(stored);

  if (request.method === 'POST' && pathname === ROUNDS_PATH) {
    if (failWrites) return new Response(null, { status: failWrites });

    // SAFETY: the typed client encoded this body with the contract's CreateRound schema.
    const body = (await request.json()) as { interviewType: string } & Partial<Schedule>;

    added.push(body);

    // The first Round moves an applied application to interviewing.
    if (stored.length === 0 && status === 'applied') status = 'interviewing';

    nextRound += 1;

    const round = {
      ...NOT_SCHEDULED,
      ...body,
      id: roundId(nextRound),
      applicationId: ACME_ID,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    };

    stored = [...stored, round];

    return Response.json(round, { status: 201 });
  }

  if (request.method === 'PUT' && pathname.endsWith('/schedule')) {
    if (failWrites) return new Response(null, { status: failWrites });

    const id = pathname.slice(ROUNDS_PATH.length + 1, -'/schedule'.length);
    const existing = stored.find((r) => r.id === id);

    if (!existing) return notFound('RoundNotFound');

    // SAFETY: the typed client encoded this body with the contract's RoundSchedule schema.
    const body = (await request.json()) as Partial<Schedule>;

    scheduled.push(body);

    // The whole schedule is replaced: what isn't sent is cleared.
    const round = { ...existing, ...NOT_SCHEDULED, ...body };

    stored = stored.map((r) => (r.id === id ? round : r));

    return Response.json(round);
  }

  if (request.method === 'DELETE' && pathname.startsWith(`${ROUNDS_PATH}/`)) {
    if (failWrites) return new Response(null, { status: failWrites });

    const id = pathname.slice(ROUNDS_PATH.length + 1);

    if (!stored.some((round) => round.id === id)) return notFound('RoundNotFound');

    stored = stored.filter((round) => round.id !== id);

    return new Response(null, { status: 204 });
  }

  return notFound('ApplicationNotFound');
}

const round = (
  n: number,
  interviewType: string,
  schedule: Partial<Schedule> = {},
): StoredRound => ({
  id: roundId(n),
  applicationId: ACME_ID,
  interviewType,
  ...NOT_SCHEDULED,
  ...schedule,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
});

beforeEach(() => {
  status = 'applied';
  stored = [];
  nextRound = 100;
  failWrites = undefined;
  added = [];
  scheduled = [];
  vi.stubGlobal('fetch', fakeServer);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const renderPage = async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createTestRouter(<ApplicationPage applicationId={ACME_ID} />, '/elsewhere');

  render(
    <QueryClientProvider client={queryClient}>
      <TestRouterProvider router={router} />
    </QueryClientProvider>,
  );

  await screen.findByRole('heading', { name: 'Rounds' });
};

/** Formatted dates' narrow spaces become plain. */
const plain = (text: string | null | undefined) => text?.replace(/\s+/g, ' ');

/** The Rounds' items in the list, in order. */
const items = async () =>
  within(await screen.findByRole('list', { name: 'Rounds' })).getAllByRole('listitem');

/** A listed Round's name, as its buttons carry it: `Coding (Not scheduled yet)`. */
const nameOf = (item: HTMLElement) =>
  plain(
    within(item)
      .getByRole('button', { name: /^Delete / })
      .getAttribute('aria-label'),
  )?.slice('Delete '.length) ?? '';

/** The Rounds as the page names them (their type and when), in order. */
const listed = async () => (await items()).map(nameOf);

/** The type a listed Round shows: the text its name starts with. */
const typeShown = (item: HTMLElement) =>
  within(item).getByText(nameOf(item).split(' (')[0] ?? '', { selector: 'span' });

/** The status the page's fields show. */
const statusShown = () => {
  const index = screen.getAllByRole('term').findIndex((term) => term.textContent === 'Status');

  return screen.getAllByRole('definition')[index]?.textContent;
};

const addRound = async (type: string) => {
  await userEvent.click(screen.getByRole('combobox', { name: 'Interview type' }));
  await userEvent.click(await screen.findByRole('option', { name: type }));
  await userEvent.click(screen.getByRole('button', { name: 'Add round' }));
};

/** When each listed Round is, as the list shows it under its type. */
const whenListed = async () =>
  (await items()).map((item) => plain(typeShown(item).nextSibling?.textContent));

/** Picks how a Round is scheduled, in the add form or the edit dialog. */
const pickWhen = async (scope: HTMLElement, label: string) => {
  await userEvent.click(within(scope).getByRole('combobox', { name: 'When' }));
  await userEvent.click(await screen.findByRole('option', { name: label }));
};

/** Sets a date or time field the way the browser's picker does: the whole value at once. */
const fill = (scope: HTMLElement, label: string, value: string) =>
  fireEvent.change(within(scope).getByLabelText(label), { target: { value } });

const addForm = () => screen.getByRole('form', { name: 'Add a round' });

/** A Round's buttons are named after its type and when it is: `Coding (Not scheduled yet)`. */
const named = (verb: string, type: string) => new RegExp(`^${verb} ${type} \\(`);

const openScheduleDialog = async (type: string) => {
  await userEvent.click(
    await screen.findByRole('button', { name: named('Edit schedule of', type) }),
  );
  const dialog = await screen.findByRole('alertdialog', { name: 'Schedule round' });

  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

  return dialog;
};

const openDeleteDialog = async (type: string) => {
  await userEvent.click(await screen.findByRole('button', { name: named('Delete', type) }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Delete round?' });

  // Base UI moves focus in on the next frame.
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

  return dialog;
};

describe('Rounds on an application’s page', () => {
  it('says there are none yet', async () => {
    await renderPage();

    expect(await screen.findByText('No rounds yet.')).toBeDefined();
    expect(screen.queryByRole('list', { name: 'Rounds' })).toBeNull();
  });

  it('lists the Rounds in the order the server sends them, by type, without numbers', async () => {
    stored = [round(1, 'recruiter_screen'), round(2, 'take_home'), round(3, 'system_design')];
    await renderPage();

    expect(await listed()).toEqual([
      'Recruiter screen (Not scheduled yet)',
      'Take-home (Not scheduled yet)',
      'System design (Not scheduled yet)',
    ]);
    expect((await items()).map((item) => typeShown(item).textContent)).toEqual([
      'Recruiter screen',
      'Take-home',
      'System design',
    ]);
    expect(screen.queryByText(/Round \d/)).toBeNull();
  });

  it('offers every Interview type, in the fixed order', async () => {
    await renderPage();
    await userEvent.click(screen.getByRole('combobox', { name: 'Interview type' }));

    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);

    expect(options).toEqual([
      'Recruiter screen',
      'Hiring manager',
      'Coding',
      'System design',
      'Behavioral',
      'Take-home',
      'Presentation',
      'Other',
    ]);
  });

  it('adds a Round of the picked type to the list', async () => {
    await renderPage();
    await addRound('Coding');

    await waitFor(async () => expect(await listed()).toEqual(['Coding (Not scheduled yet)']));
    expect(added).toEqual([{ interviewType: 'coding' }]);
    expect(screen.queryByText('No rounds yet.')).toBeNull();
  });

  it('adds a Recruiter screen when the type isn’t changed', async () => {
    await renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Add round' }));

    await waitFor(async () =>
      expect(await listed()).toEqual(['Recruiter screen (Not scheduled yet)']),
    );
  });

  it('shows the application as interviewing once its first Round is added', async () => {
    await renderPage();
    expect(statusShown()).toBe('Applied');

    await addRound('Behavioral');

    await waitFor(() => expect(statusShown()).toBe('Interviewing'));
  });

  it('shows why a Round couldn’t be added', async () => {
    failWrites = 500;
    await renderPage();
    await addRound('Coding');

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Something went wrong. Please try again.',
    );
    expect(screen.getByText('No rounds yet.')).toBeDefined();
  });

  it('deletes a Round after confirming, naming it in the dialog', async () => {
    stored = [round(1, 'coding'), round(2, 'behavioral')];
    await renderPage();

    const dialog = await openDeleteDialog('Behavioral');

    expect(dialog.textContent).toContain('Behavioral (Not scheduled yet) will be deleted.');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await listed()).toEqual(['Coding (Not scheduled yet)']);
    expect(stored.map((r) => r.id)).toEqual([roundId(1)]);
  });

  it('keeps the Round when the user cancels', async () => {
    stored = [round(1, 'coding')];
    await renderPage();

    const dialog = await openDeleteDialog('Coding');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(stored).toHaveLength(1);
    expect(await listed()).toEqual(['Coding (Not scheduled yet)']);
  });

  it('closes the dialog when the Round was already deleted elsewhere', async () => {
    stored = [round(1, 'coding')];
    await renderPage();

    const dialog = await openDeleteDialog('Coding');

    stored = [];
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await screen.findByText('No rounds yet.')).toBeDefined();
  });

  it('keeps the dialog open with the error inside when the delete fails', async () => {
    stored = [round(1, 'coding')];
    await renderPage();

    const dialog = await openDeleteDialog('Coding');

    failWrites = 500;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Something went wrong. Please try again.',
    );
    expect(screen.getByRole('alertdialog')).toBe(dialog);
  });
});

// The tests run in America/Los_Angeles (vite.config.ts): UTC−8 on these November dates.
describe('a Round’s schedule', () => {
  it('adds a Round at a local time with a duration, and shows its start and end', async () => {
    await renderPage();
    await pickWhen(addForm(), 'At a time');
    fill(addForm(), 'Starts', '2026-11-25T10:00');
    fill(addForm(), 'Duration (minutes)', '90');
    await userEvent.click(screen.getByRole('button', { name: 'Add round' }));

    await waitFor(async () =>
      expect(await whenListed()).toEqual(['Nov 25, 2026, 10:00 – 11:30 AM']),
    );
    expect(added).toEqual([
      {
        interviewType: 'recruiter_screen',
        startsAt: '2026-11-25T18:00:00.000Z',
        durationMinutes: 90,
      },
    ]);
  });

  it('adds a Round with a start and no duration, showing just its start', async () => {
    await renderPage();
    await pickWhen(addForm(), 'At a time');
    fill(addForm(), 'Starts', '2026-11-25T16:30');
    await userEvent.click(screen.getByRole('button', { name: 'Add round' }));

    await waitFor(async () => expect(await whenListed()).toEqual(['Nov 25, 2026, 4:30 PM']));
    expect(added).toEqual([
      { interviewType: 'recruiter_screen', startsAt: '2026-11-26T00:30:00.000Z' },
    ]);
  });

  it('shows a start the server sends in the user’s time zone, a day earlier than UTC', async () => {
    stored = [round(1, 'coding', { startsAt: '2026-11-26T01:30:00.000Z', durationMinutes: 45 })];
    await renderPage();

    expect(await whenListed()).toEqual(['Nov 25, 2026, 5:30 – 6:15 PM']);
  });

  it('adds a take-home due on a date, and shows it as due that day', async () => {
    await renderPage();
    await userEvent.click(screen.getByRole('combobox', { name: 'Interview type' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Take-home' }));
    await pickWhen(addForm(), 'Due by a date');
    fill(addForm(), 'Due date', '2026-12-01');
    await userEvent.click(screen.getByRole('button', { name: 'Add round' }));

    await waitFor(async () => expect(await whenListed()).toEqual(['Due Dec 1, 2026']));
    expect(added).toEqual([{ interviewType: 'take_home', dueOn: '2026-12-01' }]);
  });

  it('adds a Round with neither as not scheduled yet', async () => {
    await renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Add round' }));

    await waitFor(async () => expect(await whenListed()).toEqual(['Not scheduled yet']));
    expect(added).toEqual([{ interviewType: 'recruiter_screen' }]);
  });

  it('sends only the picked kind’s fields after switching kinds', async () => {
    await renderPage();
    await pickWhen(addForm(), 'At a time');
    fill(addForm(), 'Starts', '2026-11-25T10:00');
    await pickWhen(addForm(), 'Due by a date');
    fill(addForm(), 'Due date', '2026-12-01');
    await userEvent.click(screen.getByRole('button', { name: 'Add round' }));

    await waitFor(() =>
      expect(added).toEqual([{ interviewType: 'recruiter_screen', dueOn: '2026-12-01' }]),
    );
  });

  it('clears the schedule fields once a Round is added', async () => {
    await renderPage();
    await pickWhen(addForm(), 'Due by a date');
    fill(addForm(), 'Due date', '2026-12-01');
    await userEvent.click(screen.getByRole('button', { name: 'Add round' }));

    await waitFor(async () => expect(await whenListed()).toEqual(['Due Dec 1, 2026']));
    expect(within(addForm()).getByRole('combobox', { name: 'When' }).textContent).toBe(
      'Not scheduled yet',
    );
    expect(within(addForm()).queryByLabelText('Due date')).toBeNull();
  });

  it.each([
    ['a start time', 'At a time', [], 'Enter the date and time it starts.'],
    ['a due date', 'Due by a date', [], 'Enter the date it’s due.'],
    [
      'a duration under 5 minutes',
      'At a time',
      [
        ['Starts', '2026-11-25T10:00'],
        ['Duration (minutes)', '4'],
      ],
      'The duration is a whole number of minutes, from 5 to 480.',
    ],
    [
      'a duration over 480 minutes',
      'At a time',
      [
        ['Starts', '2026-11-25T10:00'],
        ['Duration (minutes)', '481'],
      ],
      'The duration is a whole number of minutes, from 5 to 480.',
    ],
    [
      'a fractional duration',
      'At a time',
      [
        ['Starts', '2026-11-25T10:00'],
        ['Duration (minutes)', '30.5'],
      ],
      'The duration is a whole number of minutes, from 5 to 480.',
    ],
  ] satisfies [string, string, [string, string][], string][])(
    'says what’s missing without sending anything: %s',
    async (_name, kind, fields, message) => {
      await renderPage();
      await pickWhen(addForm(), kind);

      for (const [label, value] of fields) fill(addForm(), label, value);
      await userEvent.click(screen.getByRole('button', { name: 'Add round' }));

      expect((await screen.findByRole('alert')).textContent).toBe(message);
      expect(added).toEqual([]);
    },
  );

  it('accepts the shortest and longest durations', async () => {
    await renderPage();

    for (const [i, minutes] of ['5', '480'].entries()) {
      await pickWhen(addForm(), 'At a time');
      fill(addForm(), 'Starts', '2026-11-25T10:00');
      fill(addForm(), 'Duration (minutes)', minutes);
      await userEvent.click(screen.getByRole('button', { name: 'Add round' }));
      await waitFor(() => expect(added).toHaveLength(i + 1));
    }

    const startsAt = '2026-11-25T18:00:00.000Z';

    expect(added).toEqual([
      { interviewType: 'recruiter_screen', startsAt, durationMinutes: 5 },
      { interviewType: 'recruiter_screen', startsAt, durationMinutes: 480 },
    ]);
  });

  it('opens the editor with the Round’s schedule filled in', async () => {
    stored = [round(1, 'coding', { startsAt: '2026-11-26T01:30:00.000Z', durationMinutes: 45 })];
    await renderPage();

    const dialog = await openScheduleDialog('Coding');

    expect(within(dialog).getByRole('combobox', { name: 'When' }).textContent).toBe('At a time');
    expect(within(dialog).getByLabelText<HTMLInputElement>('Starts').value).toBe(
      '2026-11-25T17:30',
    );
    expect(within(dialog).getByLabelText<HTMLInputElement>('Duration (minutes)').value).toBe('45');
  });

  it('opens the editor for a take-home with its due date', async () => {
    stored = [round(1, 'take_home', { dueOn: '2026-12-01' })];
    await renderPage();

    const dialog = await openScheduleDialog('Take-home');

    expect(within(dialog).getByRole('combobox', { name: 'When' }).textContent).toBe(
      'Due by a date',
    );
    expect(within(dialog).getByLabelText<HTMLInputElement>('Due date').value).toBe('2026-12-01');
  });

  it('sets, changes and clears a Round’s schedule', async () => {
    stored = [round(1, 'coding')];
    await renderPage();

    let dialog = await openScheduleDialog('Coding');

    expect(within(dialog).getByRole('combobox', { name: 'When' }).textContent).toBe(
      'Not scheduled yet',
    );
    await pickWhen(dialog, 'At a time');
    fill(dialog, 'Starts', '2026-11-25T09:15');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await whenListed()).toEqual(['Nov 25, 2026, 9:15 AM']);

    dialog = await openScheduleDialog('Coding');
    await pickWhen(dialog, 'Due by a date');
    fill(dialog, 'Due date', '2026-11-30');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(async () => expect(await whenListed()).toEqual(['Due Nov 30, 2026']));

    dialog = await openScheduleDialog('Coding');
    await pickWhen(dialog, 'Not scheduled yet');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(async () => expect(await whenListed()).toEqual(['Not scheduled yet']));
    expect(scheduled).toEqual([
      { startsAt: '2026-11-25T17:15:00.000Z' },
      { dueOn: '2026-11-30' },
      {},
    ]);
  });

  it('keeps the schedule when the user cancels', async () => {
    stored = [round(1, 'take_home', { dueOn: '2026-12-01' })];
    await renderPage();

    const dialog = await openScheduleDialog('Take-home');

    fill(dialog, 'Due date', '2026-12-05');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(scheduled).toEqual([]);
    expect(await whenListed()).toEqual(['Due Dec 1, 2026']);
  });

  it('keeps the editor open with what’s missing, sending nothing', async () => {
    stored = [round(1, 'coding')];
    await renderPage();

    const dialog = await openScheduleDialog('Coding');

    await pickWhen(dialog, 'At a time');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Enter the date and time it starts.',
    );
    expect(scheduled).toEqual([]);
  });

  it.each([
    [500, 'Something went wrong. Please try again.'],
    [404, 'That round no longer exists.'],
  ])('keeps the editor open with the error when saving fails (%i)', async (code, message) => {
    stored = [round(1, 'coding')];
    await renderPage();

    const dialog = await openScheduleDialog('Coding');

    if (code === 404) stored = [];
    else failWrites = code;

    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect((await within(dialog).findByRole('alert')).textContent).toBe(message);
    expect(screen.getByRole('alertdialog')).toBe(dialog);
  });

  it('orders a take-home by its due day in the user’s time zone, not by midnight UTC', async () => {
    // 5 PM on Nov 30 here is 01:00 UTC on Dec 1, after the server's midnight for a take-home due
    // that day, so the server sends the take-home first.
    stored = [
      round(1, 'take_home', { dueOn: '2026-12-01' }),
      round(2, 'coding', { startsAt: '2026-12-01T01:00:00.000Z' }),
      round(3, 'behavioral'),
      round(4, 'presentation', { dueOn: '2026-11-29' }),
    ];
    await renderPage();

    expect(await whenListed()).toEqual([
      'Due Nov 29, 2026',
      'Nov 30, 2026, 5:00 PM',
      'Due Dec 1, 2026',
      'Not scheduled yet',
    ]);
  });

  it('shows the Rounds in the server’s order, dated or not', async () => {
    stored = [
      round(1, 'coding', { startsAt: '2026-11-25T18:00:00.000Z' }),
      round(2, 'take_home', { dueOn: '2026-12-01' }),
      round(3, 'behavioral'),
    ];
    await renderPage();

    expect(await listed()).toEqual([
      'Coding (Nov 25, 2026, 10:00 AM)',
      'Take-home (Due Dec 1, 2026)',
      'Behavioral (Not scheduled yet)',
    ]);
    expect(await whenListed()).toEqual([
      'Nov 25, 2026, 10:00 AM',
      'Due Dec 1, 2026',
      'Not scheduled yet',
    ]);
  });
});
