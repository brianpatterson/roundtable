import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { SnackbarProvider, createSnackbars } from '../../design-system';
import { serverError, setUpFakeApi } from '../../shared/testing/fake-api';
import { createTestRouter, TestRouterProvider, type TestRouter } from '../../shared/testing/router';
import { AgendaPage } from './AgendaPage';
import { ApplicationsTable } from './ApplicationsTable';

// The table calls the real typed client, answered by the in-memory API.
const fake = setUpFakeApi();

const ACME_ID = '00000000-0000-4000-8000-000000000001';
const GLOBEX_ID = '00000000-0000-4000-8000-000000000002';

const APPLIED_AT = '2026-10-30T12:00:00.000Z';

beforeEach(() => {
  // Each with one unscheduled Round, so it's on the Agenda while it's open.
  for (const [id, company, jobTitle] of [
    [ACME_ID, 'Acme', 'Engineer'],
    [GLOBEX_ID, 'Globex', 'Designer'],
  ] as const) {
    fake.seedApplication({ id, company, jobTitle, appliedAt: new Date(APPLIED_AT) });
    fake.seedRound(id);
  }
});

const statusOf = (id: string) => fake.application(id)?.status;

/** The applications the table asked to delete, by id. */
const deletes = () => fake.received('applications.delete').map(({ id }) => id);

/** A request the fake holds until `release` is called. */
const hold = () => {
  let release = () => {};

  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { held, release };
};

const renderTable = async (page = <ApplicationsTable />) => {
  // The shell mounts the snackbars once, around every module, and shows the errors of mutations
  // that opt in with `meta: { errorSnackbar: true }`. Modules can't import the shell, so this
  // stands in for that part of it (which errors it leaves out is the shell's, in its own tests).
  const appSnackbars = createSnackbars();

  const queryClient = new QueryClient({
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (mutation.meta?.errorSnackbar) appSnackbars.show(error.message);
      },
    }),
    defaultOptions: { queries: { retry: false } },
  });

  // The table links each company to its page, so it renders inside a router.
  router = createTestRouter(page);

  const { container } = render(
    <SnackbarProvider snackbars={appSnackbars}>
      <QueryClientProvider client={queryClient}>
        <TestRouterProvider router={router} />
      </QueryClientProvider>
    </SnackbarProvider>,
  );

  await screen.findByRole('table');

  return container;
};

/** The router the last `renderTable` rendered in. */
let router: TestRouter;

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

    await waitFor(() => expect(statusOf(ACME_ID)).toBe('offer'));
    await waitFor(() => expect(statusFor('Acme').textContent).toContain('Offer'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // A rejection fails the Rounds of the user's day, so the API needs to know which day that is.
  it('sends the user’s time zone with the change', async () => {
    await renderTable();
    await changeStatus('Acme', 'Rejected');

    await waitFor(() => expect(statusOf(ACME_ID)).toBe('rejected'));
    expect(fake.received('applications.update')).toEqual([
      { status: 'rejected', timeZone: 'America/Los_Angeles' },
    ]);
  });

  it('shows a failure in an announced snackbar, not an alert above the table', async () => {
    fake.on('applications.update', serverError);
    const container = await renderTable();

    await changeStatus('Acme', 'Offer');

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Something went wrong. Please try again.',
    );
    expect(snackbars()).toHaveLength(1);
    expect(within(container).queryByRole('alert')).toBeNull();
  });

  // The table and the Agenda share one cache in the app, so the change has to reach the Agenda.
  it('drops the application’s Rounds from the Agenda once it’s rejected', async () => {
    await renderTable(
      <>
        <ApplicationsTable />
        <AgendaPage />
      </>,
    );

    const agenda = screen.getByRole('region', { name: 'Agenda' });

    expect(await within(agenda).findByRole('link', { name: /Acme/ })).toBeDefined();

    await changeStatus('Acme', 'Rejected');

    await waitFor(() => expect(within(agenda).queryByRole('link', { name: /Acme/ })).toBeNull());
    expect(within(agenda).getByRole('link', { name: /Globex/ })).toBeDefined();
  });

  it("keeps showing the server's status in the row after a failed change", async () => {
    // The PATCH fails, but meanwhile the status changed elsewhere (another tab, say).
    fake.on('applications.update', () => {
      fake.changeApplication(ACME_ID, { status: 'interviewing' });

      return serverError();
    });

    await renderTable();

    await changeStatus('Acme', 'Offer');
    await screen.findByRole('alert');

    // The list is asked again after the failure, so the row shows what the server now has.
    await waitFor(() => expect(statusFor('Acme').textContent).toContain('Interviewing'));
    expect(statusFor('Acme').textContent).not.toContain('Offer');
  });

  it('shows the snackbar until it is dismissed', async () => {
    fake.on('applications.update', serverError);
    await renderTable();
    await changeStatus('Acme', 'Offer');
    await screen.findByRole('alert');

    const snackbar = screen.getByRole('alertdialog', { hidden: true });

    await userEvent.click(within(snackbar).getByRole('button', { name: 'Dismiss', hidden: true }));

    await waitFor(() => expect(snackbars()).toEqual([]));
  });

  it('shows a message for each of two failures in a row', async () => {
    fake.on('applications.update', serverError);
    await renderTable();

    await changeStatus('Acme', 'Offer');
    await changeStatus('Globex', 'Rejected');

    await waitFor(() => expect(fake.received('applications.update')).toHaveLength(2));
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
    expect(snackbars()).toHaveLength(2);
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
    expect(deletes()).toEqual([]);
    expect(screen.getByRole('row', { name: /Acme/ })).toBeDefined();
    expect(document.activeElement).toBe(deleteButtonFor('Acme'));
  });

  it('deletes on Delete, both buttons disabled while the request is in flight, then closes', async () => {
    const { held, release } = hold();

    fake.on('applications.delete', async () => {
      await held;

      return undefined;
    });
    await renderTable();
    const dialog = await openDialogFor('Acme');
    const confirmButton = within(dialog).getByRole('button', { name: 'Delete' });
    const cancelButton = within(dialog).getByRole('button', { name: 'Cancel' });

    expect(cancelButton.hasAttribute('data-disabled')).toBe(false);

    await userEvent.click(confirmButton);
    await waitFor(() => expect(deletes()).toEqual([ACME_ID]));
    expect(confirmButton.hasAttribute('data-disabled')).toBe(true);
    expect(cancelButton.hasAttribute('data-disabled')).toBe(true);

    await userEvent.click(confirmButton);
    await userEvent.click(cancelButton);
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBe(dialog);
    release();

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(deletes()).toEqual([ACME_ID]);
    expect(screen.queryByRole('row', { name: /Acme/ })).toBeNull();
    expect(screen.getByRole('row', { name: /Globex/ })).toBeDefined();
  });

  it('keeps the dialog open and shows the error inside it when the delete fails', async () => {
    fake.on('applications.delete', serverError);
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
    const { held, release: fail } = hold();

    fake.on('applications.delete', async () => {
      await held;

      return serverError();
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
    fake.removeApplication(ACME_ID);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('row', { name: /Acme/ })).toBeNull();
    expect(screen.getByRole('row', { name: /Globex/ })).toBeDefined();
  });

  it("opens again without the last attempt's error", async () => {
    fake.on('applications.delete', serverError);
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

describe('ApplicationsTable: statuses and the applied date (ADR-0045)', () => {
  const cellsOf = (company: string) =>
    within(screen.getByRole('row', { name: new RegExp(company) })).getAllByRole('cell');

  const appliedCellOf = (company: string) => cellsOf(company)[3]?.textContent;

  it('shows when each application was sent, not when it was created', async () => {
    await renderTable();

    expect(screen.getByRole('columnheader', { name: 'Applied' })).toBeDefined();
    expect(appliedCellOf('Acme')).toBe(new Date(APPLIED_AT).toLocaleDateString());
  });

  it('offers Saved first, and no Screening', async () => {
    await renderTable();
    await userEvent.click(statusFor('Acme'));

    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);

    expect(options).toEqual([
      'Saved',
      'Applied',
      'Interviewing',
      'Offer',
      'Accepted',
      'Rejected',
      'Withdrawn',
    ]);
  });

  it('shows a saved row as Saved and Not sent, and dates it once moved to Applied', async () => {
    fake.changeApplication(ACME_ID, { status: 'saved', appliedAt: null });

    await renderTable();

    expect(statusFor('Acme').textContent).toContain('Saved');
    expect(appliedCellOf('Acme')).toBe('Not sent');

    await changeStatus('Acme', 'Applied');

    await waitFor(() => expect(appliedCellOf('Acme')).not.toBe('Not sent'));
    expect(statusOf(ACME_ID)).toBe('applied');
  });
});

describe('ApplicationsTable: each application’s page', () => {
  it('links each company name to its application’s page', async () => {
    await renderTable();

    const acme = screen.getByRole('link', { name: 'Acme' });

    expect(acme.getAttribute('href')).toBe(`/applications/${ACME_ID}`);
    expect(screen.getByRole('link', { name: 'Globex' }).getAttribute('href')).toBe(
      `/applications/${GLOBEX_ID}`,
    );

    await userEvent.click(acme);

    expect(router.state.location.pathname).toBe(`/applications/${ACME_ID}`);
  });
});
