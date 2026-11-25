import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';
import { serverError, setUpFakeApi } from '../shared/testing/fake-api';

// Session expiry, for every module at once: the whole shell renders against the in-memory API.
// The session answers with a user; then the server's session expires, the way one runs out:
// applications calls answer 401 and Better Auth's session answers null.
const fake = setUpFakeApi();

beforeEach(() => {
  fake.seedApplication({ company: 'Acme', jobTitle: 'Engineer', status: 'applied' });
});

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

/** How many calls answered `status`, and from which endpoint. */
const answered = (status: number) => fake.calls().filter((call) => call.status === status);

/** How many reads of the applications list answered 500. */
const failedReads = () =>
  answered(500).filter((call) => call.endpoint === 'applications.list').length;

// Better Auth's session store unsubscribes from `window` a second after the last test unmounts
// it. Wait for that here, or it runs after jsdom has torn the window down and throws.
afterAll(() => new Promise((resolve) => setTimeout(resolve, 1100)));

/** Renders the whole app at `path`: by default the applications table, which these tests use. */
const renderShell = async (path = '/applications') => {
  window.history.replaceState(null, '', path);
  // Better Auth keeps the session in a store created with the client, which outlives a test
  // (it stays subscribed for a second after unmount). Fresh modules give each test a new one.
  vi.resetModules();
  const { App } = await import('./App');
  const { createQueryClient } = await import('./Providers');
  const { SnackbarProvider, ThemeProvider, createSnackbars } = await import('../design-system');
  const { QueryClientProvider } = await import('@tanstack/react-query');
  // The app's own cache setup, in a client the test can look inside.
  const snackbars = createSnackbars();
  const queryClient = createQueryClient(snackbars);

  render(
    <ThemeProvider>
      <SnackbarProvider snackbars={snackbars}>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </SnackbarProvider>
    </ThemeProvider>,
  );

  return queryClient;
};

/** Every query and mutation of the signed-in app is gone; only the sign-in page's own remain. */
const expectSignedInCacheCleared = (queryClient: QueryClient) => {
  expect(queryClient.getQueryCache().findAll({ queryKey: ['applications'] })).toEqual([]);
  expect(queryClient.getMutationCache().getAll()).toEqual([]);
};

const expectSignInPageWithNotice = async () => {
  expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeDefined();
  expect(screen.getByRole('status').textContent).toBe('You were signed out. Sign in again.');
  expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
};

describe('App: session expiry', () => {
  it('returns to the sign-in page, with a notice, when an applications query answers 401', async () => {
    fake.expireSessionAfter(0);
    const queryClient = await renderShell();

    await expectSignInPageWithNotice();
    expectSignedInCacheCleared(queryClient);
    // Not retried: asking again won't bring the session back.
    expect(answered(401)).toHaveLength(1);
  });

  it('returns to the sign-in page, with a notice, when an applications mutation answers 401', async () => {
    fake.expireSessionAfter(1);
    const queryClient = await renderShell();

    expect(await screen.findByRole('row', { name: /Acme/ })).toBeDefined();
    await userEvent.type(screen.getByLabelText('Company'), 'Globex');
    await userEvent.type(screen.getByLabelText('Job title'), 'Designer');
    await userEvent.click(screen.getByRole('button', { name: 'Add as applied' }));

    await expectSignInPageWithNotice();
    expectSignedInCacheCleared(queryClient);
  });

  it('returns to the sign-in page, with a notice and no snackbar, when a status change answers 401', async () => {
    fake.expireSessionAfter(1);
    const queryClient = await renderShell();

    expect(await screen.findByRole('row', { name: /Acme/ })).toBeDefined();
    await userEvent.click(screen.getByRole('combobox', { name: 'Status for Acme' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Offer' }));

    await expectSignInPageWithNotice();
    expect(screen.queryAllByRole('alertdialog', { hidden: true })).toEqual([]);
    expectSignedInCacheCleared(queryClient);
  });

  it('shows the signed-in app once the user signs in again, and no notice after signing out', async () => {
    fake.expireSessionAfter(0);
    const queryClient = await renderShell();

    await expectSignInPageWithNotice();
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('row', { name: /Acme/ })).toBeDefined();
    expect(screen.getByText('Ada')).toBeDefined();
    expect(screen.queryByRole('status')).toBeNull();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeDefined();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows no old notice when the new session later ends without a 401', async () => {
    fake.expireSessionAfter(0);
    await renderShell();

    await expectSignInPageWithNotice();
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('row', { name: /Acme/ })).toBeDefined();

    // The new session ends on the server; Better Auth finds out when the tab is shown again.
    fake.endSession();
    document.dispatchEvent(new Event('visibilitychange'));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeDefined();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('retries a read that fails for another reason, and shows the list once it succeeds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let failingReads = 1;

    fake.on('applications.list', () => {
      if (failingReads === 0) return undefined;

      failingReads -= 1;

      return serverError();
    });
    await renderShell();

    await waitFor(() => expect(failedReads()).toBe(1));
    // TanStack waits a second before its first retry.
    await vi.advanceTimersByTimeAsync(1000);

    expect(await screen.findByRole('row', { name: /Acme/ })).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDefined();
  });

  it('retries a read that keeps failing three times, then shows the error', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fake.on('applications.list', serverError);
    await renderShell();

    await waitFor(() => expect(failedReads()).toBe(1));
    // TanStack waits 1 s, 2 s, then 4 s between retries.
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Something went wrong. Please try again.',
    );
    // Long past any further back-off: no fifth read.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failedReads()).toBe(4);
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDefined();
  });

  it('keeps the user signed in, showing the error, when a sign-out fails', async () => {
    // The server's session stays.
    fake.on('auth.signOut', serverError);
    await renderShell();

    expect(await screen.findByRole('row', { name: /Acme/ })).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      "Couldn't sign out. Check your connection and try again.",
    );
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull();
  });

  it('keeps the user signed in, showing the error, when a request fails for another reason', async () => {
    // A 500 has nothing to do with the session.
    fake.on('applications.create', serverError);
    await renderShell();

    expect(await screen.findByRole('row', { name: /Acme/ })).toBeDefined();
    await userEvent.type(screen.getByLabelText('Company'), 'Globex');
    await userEvent.type(screen.getByLabelText('Job title'), 'Designer');
    await userEvent.click(screen.getByRole('button', { name: 'Add as applied' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Something went wrong. Please try again.',
    );
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDefined();
  });
});

describe('App: report a problem', () => {
  const sendReport = async (description: string) => {
    await userEvent.click(screen.getByRole('button', { name: 'Report a problem' }));
    await screen.findByRole('alertdialog', { name: 'Report a problem' });
    await userEvent.type(screen.getByLabelText('What went wrong?'), description);
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await screen.findByText(/^Report report-1\./);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
  };

  it('is offered on the sign-in page, with no reply email filled in', async () => {
    fake.endSession();
    await renderShell('/');

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Report a problem' }));
    await screen.findByRole('alertdialog', { name: 'Report a problem' });
    expect(screen.getByLabelText<HTMLInputElement>('Reply email').value).toBe('');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await sendReport('GitHub sign-in failed');
    expect(fake.received('support.createReport')).toEqual([
      {
        description: 'GitHub sign-in failed',
        replyEmail: null,
        pagePath: '/',
        // What the app asked the API before the report, through the real clients (ADR-0041).
        diagnostics: expect.objectContaining({
          requests: expect.arrayContaining([
            expect.objectContaining({ method: 'GET', path: '/api/auth/get-session' }),
            expect.objectContaining({ method: 'GET', path: '/api/auth-config', status: 200 }),
          ]),
        }),
      },
    ]);
  });

  it('is in the footer when signed in, with the account email as the reply email', async () => {
    await renderShell();

    expect(await screen.findByRole('row', { name: /Acme/ })).toBeDefined();
    expect(
      within(screen.getByRole('contentinfo')).getByRole('button', { name: 'Report a problem' }),
    ).toBeDefined();

    await sendReport('The table is empty');
    expect(fake.received('support.createReport')).toEqual([
      {
        description: 'The table is empty',
        replyEmail: 'ada@example.com',
        pagePath: '/applications',
        diagnostics: expect.objectContaining({
          requests: expect.arrayContaining([
            expect.objectContaining({ method: 'GET', path: '/api/applications', status: 200 }),
          ]),
        }),
      },
    ]);
    // Still signed in: the report has nothing to do with the session.
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDefined();
  });
});
