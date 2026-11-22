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

/** A Round's Tags: the Round's id is the match's first group. */
const TAGS_PATH = new RegExp(`^${ROUNDS_PATH}/([^/]+)/tags$`);

const TIMESTAMP = '2026-11-01T00:00:00.000Z';

interface StoredRound {
  id: string;
  applicationId: string;
  interviewType: string;
  tags: string[];
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
      tags: [],
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    };

    stored = [...stored, round];

    return Response.json(round, { status: 201 });
  }

  const tags = TAGS_PATH.exec(pathname);

  if (tags) {
    if (failWrites) return new Response(null, { status: failWrites });

    const target = stored.find((r) => r.id === tags[1]);

    if (!target) return notFound('RoundNotFound');

    // Matched the way the API does: trimmed, ignoring case.
    const same = (a: string) => (b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

    if (request.method === 'POST') {
      // SAFETY: the typed client encoded this body with the contract's RoundTag schema.
      const { tag } = (await request.json()) as { tag: string };

      if (!target.tags.some(same(tag))) {
        if (target.tags.length >= 10)
          return Response.json({ _tag: 'TooManyTags' }, { status: 400 });

        target.tags = [...target.tags, tag];
      }
    } else {
      const tag = new URL(request.url).searchParams.get('tag') ?? '';

      target.tags = target.tags.filter((t) => !same(tag)(t));
    }

    return Response.json(target);
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

const round = (n: number, interviewType: string, tags: string[] = []): StoredRound => ({
  id: roundId(n),
  applicationId: ACME_ID,
  interviewType,
  tags,
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

  // Only the Rounds themselves: each holds a list of its Tags too.
  return within(list)
    .getAllByRole('listitem')
    .filter((item) => item.parentElement === list)
    .map((item) => within(item).getByText(/^Round \d+:/).textContent);
};

/** Where a Round's Tags are shown and added, e.g. `tagsGroup('Round 1')`. */
const tagsGroup = (name: string) => screen.getByRole('group', { name: `${name} tags` });

/** The Tags a Round shows, in order. */
const tagsShown = (name: string) =>
  within(tagsGroup(name))
    .queryAllByRole('listitem')
    .map((item) => item.textContent);

const addTag = async (name: string, tag: string) => {
  const group = tagsGroup(name);

  await userEvent.type(within(group).getByRole('textbox', { name: 'Tag' }), tag);
  await userEvent.click(within(group).getByRole('button', { name: 'Add tag' }));
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

const tagField = (name: string) =>
  within(tagsGroup(name)).getByRole<HTMLInputElement>('textbox', { name: 'Tag' });

describe('Tags on a Round', () => {
  it('shows a Round’s Tags in order', async () => {
    stored = [round(1, 'coding', ['React', 'SQL']), round(2, 'behavioral')];
    await renderPage();
    await listed();

    expect(tagsShown('Round 1')).toEqual(['React', 'SQL']);
    expect(tagsShown('Round 2')).toEqual([]);
  });

  it('adds a Tag to that Round only, and empties the field', async () => {
    stored = [round(1, 'coding', ['React']), round(2, 'behavioral')];
    await renderPage();
    await listed();
    await addTag('Round 1', 'live debugging');

    await waitFor(() => expect(tagsShown('Round 1')).toEqual(['React', 'live debugging']));
    expect(tagsShown('Round 2')).toEqual([]);
    expect(tagField('Round 1').value).toBe('');
  });

  it('adds a Tag with Enter', async () => {
    stored = [round(1, 'coding')];
    await renderPage();
    await listed();
    await userEvent.type(tagField('Round 1'), 'SQL[Enter]');

    await waitFor(() => expect(tagsShown('Round 1')).toEqual(['SQL']));
  });

  it('removes a Tag', async () => {
    stored = [round(1, 'coding', ['React', 'SQL', 'Go'])];
    await renderPage();
    await listed();
    await userEvent.click(within(tagsGroup('Round 1')).getByRole('button', { name: 'Remove SQL' }));

    await waitFor(() => expect(tagsShown('Round 1')).toEqual(['React', 'Go']));
    expect(stored[0]?.tags).toEqual(['React', 'Go']);
  });

  it('keeps one Tag when the same one is added in another case or with spaces', async () => {
    stored = [round(1, 'coding', ['SQL'])];
    await renderPage();
    await listed();
    await addTag('Round 1', '  sql ');

    await waitFor(() => expect(tagField('Round 1').value).toBe(''));
    expect(tagsShown('Round 1')).toEqual(['SQL']);
    expect(stored[0]?.tags).toEqual(['SQL']);
  });

  it('says why a blank Tag isn’t added', async () => {
    stored = [round(1, 'coding')];
    await renderPage();
    await listed();
    await addTag('Round 1', '   ');

    expect(await within(tagsGroup('Round 1')).findByText(/must not be blank/)).toBeDefined();
    expect(tagField('Round 1').getAttribute('aria-invalid')).toBe('true');
    expect(tagsShown('Round 1')).toEqual([]);
  });

  it('says why a Tag over 40 characters isn’t added', async () => {
    stored = [round(1, 'coding')];
    await renderPage();
    await listed();
    await addTag('Round 1', 'x'.repeat(41));

    expect(
      await within(tagsGroup('Round 1')).findByText(/must be at most 40 characters/),
    ).toBeDefined();
    expect(tagsShown('Round 1')).toEqual([]);
  });

  it('says why an eleventh Tag isn’t added, keeping what was typed', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => `tag ${i + 1}`);

    stored = [round(1, 'coding', ten)];
    await renderPage();
    await listed();
    await addTag('Round 1', 'one more');

    expect(
      await within(tagsGroup('Round 1')).findByText('A round can have at most 10 tags.'),
    ).toBeDefined();
    expect(tagField('Round 1').value).toBe('one more');
    expect(tagsShown('Round 1')).toEqual(ten);
  });

  it('clears the message once the user types again', async () => {
    stored = [round(1, 'coding')];
    await renderPage();
    await listed();
    await addTag('Round 1', ' ');
    await within(tagsGroup('Round 1')).findByText(/must not be blank/);
    await userEvent.type(tagField('Round 1'), 'R');

    expect(within(tagsGroup('Round 1')).queryByText(/must not be blank/)).toBeNull();
  });

  it('says why a Tag couldn’t be removed', async () => {
    stored = [round(1, 'coding', ['React'])];
    await renderPage();
    await listed();

    failWrites = 500;
    await userEvent.click(
      within(tagsGroup('Round 1')).getByRole('button', { name: 'Remove React' }),
    );

    expect((await within(tagsGroup('Round 1')).findByRole('alert')).textContent).toBe(
      'Something went wrong. Please try again.',
    );
    expect(tagsShown('Round 1')).toEqual(['React']);
  });
});
