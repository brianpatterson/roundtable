import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationsTable } from './ApplicationsTable';

// The table calls the real typed client; only the server behind `fetch` is a stand-in, holding a
// list of applications in memory and answering the two endpoints the table uses.
const ACME_ID = '00000000-0000-4000-8000-000000000001';
const GLOBEX_ID = '00000000-0000-4000-8000-000000000002';

const row = (id: string, company: string, jobTitle: string) => ({
  id,
  company,
  jobTitle,
  jobUrl: null,
  status: 'applied',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-02T00:00:00.000Z',
});

let rows: ReturnType<typeof row>[];
let deletes: string[];

/** How the server answers a DELETE; a test can make it fail, or hold it in flight. */
let answerDelete: () => Promise<Response>;

const noContent = () => Promise.resolve(new Response(null, { status: 204 }));

async function fakeServer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const { pathname } = new URL(request.url);

  if (request.method === 'GET' && pathname === '/api/applications') return Response.json(rows);

  const id = pathname.replace('/api/applications/', '');

  if (request.method === 'DELETE' && rows.some((r) => r.id === id)) {
    deletes.push(id);
    const response = await answerDelete();

    if (response.ok) rows = rows.filter((r) => r.id !== id);

    return response;
  }

  // What the real API answers for an id that isn't (or is no longer) there.
  if (request.method === 'DELETE') return Response.json({ _tag: 'ApplicationNotFound' }, notFound);

  return new Response(null, notFound);
}

const notFound = { status: 404 };

beforeEach(() => {
  rows = [row(ACME_ID, 'Acme', 'Engineer'), row(GLOBEX_ID, 'Globex', 'Designer')];
  deletes = [];
  answerDelete = noContent;
  vi.stubGlobal('fetch', fakeServer);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const renderTable = async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={queryClient}>
      <ApplicationsTable />
    </QueryClientProvider>,
  );
  await screen.findByRole('table');
};

const deleteButtonFor = (company: string) =>
  within(screen.getByRole('row', { name: new RegExp(company) })).getByRole('button', {
    name: 'Delete',
  });

const openDialogFor = async (company: string) => {
  await userEvent.click(deleteButtonFor(company));
  const dialog = await screen.findByRole('alertdialog', { name: 'Delete application?' });

  // Base UI moves focus in on the next frame.
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

  return dialog;
};

describe('ApplicationsTable: deleting', () => {
  it("asks in a dialog that names the row's company and job title, with focus inside", async () => {
    await renderTable();
    const dialog = await openDialogFor('Globex');

    expect(within(dialog).getByText(/Globex/).textContent).toContain('Designer');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDefined();
    expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeDefined();
  });

  it.each([
    ['pressing Escape', () => userEvent.keyboard('{Escape}')],
    ['clicking Cancel', () => userEvent.click(screen.getByRole('button', { name: 'Cancel' }))],
  ])('closes on %s without deleting, and returns focus to that row', async (_, dismiss) => {
    await renderTable();
    await openDialogFor('Acme');
    await dismiss();

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(deletes).toEqual([]);
    expect(screen.getByRole('row', { name: /Acme/ })).toBeDefined();
    expect(document.activeElement).toBe(deleteButtonFor('Acme'));
  });

  it('deletes on Delete, both buttons disabled while the request is in flight, then closes', async () => {
    let respond = () => {};

    answerDelete = () =>
      new Promise((resolve) => {
        respond = () => resolve(new Response(null, { status: 204 }));
      });
    await renderTable();
    const dialog = await openDialogFor('Acme');
    const confirmButton = within(dialog).getByRole('button', { name: 'Delete' });
    const cancelButton = within(dialog).getByRole('button', { name: 'Cancel' });

    expect(cancelButton.hasAttribute('data-disabled')).toBe(false);

    await userEvent.click(confirmButton);
    await waitFor(() => expect(deletes).toEqual([ACME_ID]));
    expect(confirmButton.hasAttribute('data-disabled')).toBe(true);
    expect(cancelButton.hasAttribute('data-disabled')).toBe(true);

    await userEvent.click(confirmButton);
    await userEvent.click(cancelButton);
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBe(dialog);
    respond();

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(deletes).toEqual([ACME_ID]);
    expect(screen.queryByRole('row', { name: /Acme/ })).toBeNull();
    expect(screen.getByRole('row', { name: /Globex/ })).toBeDefined();
  });

  it('keeps the dialog open and shows the error inside it when the delete fails', async () => {
    answerDelete = () => Promise.resolve(new Response(null, { status: 500 }));
    await renderTable();
    const dialog = await openDialogFor('Acme');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Something went wrong. Please try again.',
    );
    expect(screen.getByRole('alertdialog')).toBe(dialog);
    // The open dialog hides the page from assistive tech, so the row is found among hidden ones.
    expect(screen.getByRole('row', { name: /Acme/, hidden: true })).toBeDefined();
  });

  it('enables both buttons again once an in-flight delete fails', async () => {
    let fail = () => {};

    answerDelete = () =>
      new Promise((resolve) => {
        fail = () => resolve(new Response(null, { status: 500 }));
      });
    await renderTable();
    const dialog = await openDialogFor('Acme');
    const confirmButton = within(dialog).getByRole('button', { name: 'Delete' });
    const cancelButton = within(dialog).getByRole('button', { name: 'Cancel' });

    await userEvent.click(confirmButton);
    await waitFor(() => expect(cancelButton.hasAttribute('data-disabled')).toBe(true));
    fail();

    await within(dialog).findByRole('alert');
    expect(confirmButton.hasAttribute('data-disabled')).toBe(false);
    expect(cancelButton.hasAttribute('data-disabled')).toBe(false);

    await userEvent.click(cancelButton);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('closes and drops the row, with no error, when it was already deleted elsewhere', async () => {
    await renderTable();
    const dialog = await openDialogFor('Acme');

    // Another tab deletes it while this dialog is open.
    rows = rows.filter((r) => r.id !== ACME_ID);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('row', { name: /Acme/ })).toBeNull();
    expect(screen.getByRole('row', { name: /Globex/ })).toBeDefined();
  });

  it("opens again without the last attempt's error", async () => {
    answerDelete = () => Promise.resolve(new Response(null, { status: 500 }));
    await renderTable();
    const dialog = await openDialogFor('Acme');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await within(dialog).findByRole('alert');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

    const reopened = await openDialogFor('Globex');

    expect(within(reopened).queryByRole('alert')).toBeNull();
  });
});
