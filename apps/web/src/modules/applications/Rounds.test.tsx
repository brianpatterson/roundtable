import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestRouter, TestRouterProvider } from '../../shared/testing/router';
import { ApplicationPage } from './ApplicationPage';

// The page calls the real typed client; only the server behind `fetch` is a stand-in, keeping one
// application and its Rounds the way the API does.
const ACME_ID = '00000000-0000-4000-8000-000000000001';
const ROUNDS_PATH = `/api/applications/${ACME_ID}/rounds`;

const TIMESTAMP = '2026-11-01T00:00:00.000Z';

interface StoredRound {
  id: string;
  applicationId: string;
  interviewType: string;
  createdAt: string;
  updatedAt: string;
}

let status: string;
let stored: StoredRound[];
let nextRound: number;

/** What the server answers a request to add or delete a Round with, unless it's the default. */
let failWrites: number | undefined;

/** The bodies the page sent to add Rounds. */
let added: unknown[];

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
    const body = (await request.json()) as { interviewType: string };

    added.push(body);

    // The first Round moves an applied application to interviewing.
    if (stored.length === 0 && status === 'applied') status = 'interviewing';

    nextRound += 1;

    const round = {
      id: roundId(nextRound),
      applicationId: ACME_ID,
      interviewType: body.interviewType,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    };

    stored = [...stored, round];

    return Response.json(round, { status: 201 });
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

const round = (n: number, interviewType: string): StoredRound => ({
  id: roundId(n),
  applicationId: ACME_ID,
  interviewType,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
});

beforeEach(() => {
  status = 'applied';
  stored = [];
  nextRound = 100;
  failWrites = undefined;
  added = [];
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

/** The Rounds as the list shows them, in order. */
const listed = async () => {
  const list = await screen.findByRole('list', { name: 'Rounds' });

  return within(list)
    .getAllByRole('listitem')
    .map((item) => within(item).getByText(/^Round \d+:/).textContent);
};

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

const openDeleteDialog = async (name: string) => {
  await userEvent.click(await screen.findByRole('button', { name: `Delete ${name}` }));
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

  it('lists the Rounds in the order the server sends them, numbered', async () => {
    stored = [round(1, 'recruiter_screen'), round(2, 'take_home'), round(3, 'system_design')];
    await renderPage();

    expect(await listed()).toEqual([
      'Round 1: Recruiter screen',
      'Round 2: Take-home',
      'Round 3: System design',
    ]);
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

    await waitFor(async () => expect(await listed()).toEqual(['Round 1: Coding']));
    expect(added).toEqual([{ interviewType: 'coding' }]);
    expect(screen.queryByText('No rounds yet.')).toBeNull();
  });

  it('adds a Recruiter screen when the type isn’t changed', async () => {
    await renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Add round' }));

    await waitFor(async () => expect(await listed()).toEqual(['Round 1: Recruiter screen']));
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

    const dialog = await openDeleteDialog('Round 2');

    expect(dialog.textContent).toContain('Round 2 (Behavioral) will be deleted.');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await listed()).toEqual(['Round 1: Coding']);
    expect(stored.map((r) => r.id)).toEqual([roundId(1)]);
  });

  it('keeps the Round when the user cancels', async () => {
    stored = [round(1, 'coding')];
    await renderPage();

    const dialog = await openDeleteDialog('Round 1');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(stored).toHaveLength(1);
    expect(await listed()).toEqual(['Round 1: Coding']);
  });

  it('closes the dialog when the Round was already deleted elsewhere', async () => {
    stored = [round(1, 'coding')];
    await renderPage();

    const dialog = await openDeleteDialog('Round 1');

    stored = [];
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await screen.findByText('No rounds yet.')).toBeDefined();
  });

  it('keeps the dialog open with the error inside when the delete fails', async () => {
    stored = [round(1, 'coding')];
    await renderPage();

    const dialog = await openDeleteDialog('Round 1');

    failWrites = 500;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Something went wrong. Please try again.',
    );
    expect(screen.getByRole('alertdialog')).toBe(dialog);
  });
});
