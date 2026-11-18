import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SnackbarProvider } from '../../design-system';
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

/** How the server answers a PATCH; null applies it. A test can make it fail. */
let failUpdate: (() => Response) | null;

/** How many PATCHes reached the server. */
let updates: number;

const serverError = () => new Response(null, { status: 500 });

async function fakeServer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const { pathname } = new URL(request.url);

  if (request.method === 'GET' && pathname === '/api/applications') return Response.json(rows);

  const id = pathname.replace('/api/applications/', '');
  const existing = rows.find((r) => r.id === id);

  if (request.method === 'PATCH' && existing) {
    updates += 1;

    if (failUpdate) return failUpdate();

    // SAFETY: the typed client encoded this body with the contract's UpdateApplication schema.
    const { status } = (await request.json()) as { status: string };

    existing.status = status;

    return Response.json(existing);
  }

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
  failUpdate = null;
  updates = 0;
  vi.stubGlobal('fetch', fakeServer);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const renderTable = async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  // The shell mounts the snackbars once, around every module.
  const { container } = render(
    <SnackbarProvider>
      <QueryClientProvider client={queryClient}>
        <ApplicationsTable />
      </QueryClientProvider>
    </SnackbarProvider>,
  );

  await screen.findByRole('table');

  return container;
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

const statusFor = (company: string) =>
  screen.getByRole('combobox', { name: `Status for ${company}` });

const changeStatus = async (company: string, status: string) => {
  await userEvent.click(statusFor(company));
  await userEvent.click(await screen.findByRole('option', { name: status }));
};

// The snackbar is announced through Base UI's hidden role="alert" copy; the visible one is hidden
// from assistive tech until the user moves into the notifications (see Snackbar.test.tsx).
const snackbars = () => screen.queryAllByRole('alertdialog', { hidden: true });

describe('ApplicationsTable: changing status', () => {
  it('saves the status the user picks', async () => {
    await renderTable();
    await changeStatus('Acme', 'Offer');

    await waitFor(() => expect(rows[0]?.status).toBe('offer'));
    await waitFor(() => expect(statusFor('Acme').textContent).toContain('Offer'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a failure in an announced snackbar, not an alert above the table', async () => {
    failUpdate = serverError;
    const container = await renderTable();

    await changeStatus('Acme', 'Offer');

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Something went wrong. Please try again.',
    );
    expect(snackbars()).toHaveLength(1);
    expect(within(container).queryByRole('alert')).toBeNull();
  });

  it("keeps showing the server's status in the row after a failed change", async () => {
    failUpdate = serverError;
    await renderTable();

    await changeStatus('Acme', 'Offer');
    await screen.findByRole('alert');

    // The list is asked again, so the row shows what the server has even if it changed elsewhere.
    await waitFor(() => expect(statusFor('Acme').textContent).toContain('Applied'));
    expect(statusFor('Acme').textContent).not.toContain('Offer');
  });

  it('shows the snackbar until it is dismissed', async () => {
    failUpdate = serverError;
    await renderTable();
    await changeStatus('Acme', 'Offer');
    await screen.findByRole('alert');

    const snackbar = screen.getByRole('alertdialog', { hidden: true });

    await userEvent.click(within(snackbar).getByRole('button', { name: 'Dismiss', hidden: true }));

    await waitFor(() => expect(snackbars()).toEqual([]));
  });

  it('shows a message for each of two failures in a row', async () => {
    failUpdate = serverError;
    await renderTable();

    await changeStatus('Acme', 'Offer');
    await changeStatus('Globex', 'Rejected');

    await waitFor(() => expect(updates).toBe(2));
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
    expect(snackbars()).toHaveLength(2);
  });

  it('shows no snackbar when the session has ended: the shell returns to sign-in instead', async () => {
    failUpdate = () => Response.json({ _tag: 'Unauthorized' }, { status: 401 });
    await renderTable();

    await changeStatus('Acme', 'Offer');
    await waitFor(() => expect(updates).toBe(1));
    // A later failure for another reason does show, and alone: the 401 left nothing behind.
    failUpdate = serverError;
    await changeStatus('Globex', 'Rejected');

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Something went wrong. Please try again.',
    );
    expect(snackbars()).toHaveLength(1);
  });
});

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
