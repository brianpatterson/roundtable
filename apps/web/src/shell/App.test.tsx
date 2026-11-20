import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';

// Session expiry, for every module at once: the whole shell renders against a stand-in `fetch`.
// The session answers once with a user; then the server's session expires, the way one runs out:
// applications calls answer 401 and Better Auth's session answers null.
const sessionFor = (id: string) => ({
  session: {
    id,
    userId: 'user-1',
    token: `token-${id}`,
    expiresAt: '2026-12-01T00:00:00.000Z',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  },
  user: {
    id: 'user-1',
    name: 'Ada',
    email: 'ada@example.com',
    emailVerified: true,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  },
});

const acme = {
  id: '00000000-0000-4000-8000-000000000001',
  company: 'Acme',
  jobTitle: 'Engineer',
  jobUrl: null,
  status: 'applied',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-02T00:00:00.000Z',
};

/** The server's session: null once it has expired. */
let session: ReturnType<typeof sessionFor> | null;

/** How many applications calls succeed before the session expires. */
let callsBeforeExpiry: number;

/** Changes fail with a 500, which has nothing to do with the session. */
let serverError: boolean;

/** How many reads of the applications list fail with a 500 before they succeed. */
let failingReads: number;

/** How many reads of the applications list answered 500. */
let failedReads: number;

/** Sign-out answers 500, so the server's session stays. */
let signOutFails: boolean;

/** How many applications calls answered 401. */
let unauthorizedAnswers: number;

/** Problem reports the server received. */
let reports: unknown[];

async function fakeServer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const { pathname } = new URL(request.url);

  if (pathname === '/api/auth/get-session') return Response.json(session);

  if (pathname === '/api/auth/sign-in/email') {
    session = sessionFor('session-2');

    return Response.json({ redirect: false, token: session.session.token, user: session.user });
  }

  if (pathname === '/api/auth/sign-out') {
    if (signOutFails) return new Response(null, { status: 500 });

    session = null;

    return Response.json({ success: true });
  }

  if (pathname === '/api/auth-config') return Response.json({ providers: [] });

  if (pathname === '/api/reports') {
    reports.push(await request.json());

    return Response.json({ id: 'report-1' }, { status: 201 });
  }

  if (request.method !== 'GET' && serverError) return new Response(null, { status: 500 });

  if (pathname.startsWith('/api/applications') && request.method === 'GET' && failingReads > 0) {
    failingReads -= 1;
    failedReads += 1;

    return new Response(null, { status: 500 });
  }

  if (pathname.startsWith('/api/applications')) {
    if (session && callsBeforeExpiry > 0) {
      callsBeforeExpiry -= 1;

      return Response.json([acme]);
    }

    session = null;
    unauthorizedAnswers += 1;

    return Response.json({ _tag: 'Unauthorized' }, { status: 401 });
  }

  return new Response(null, { status: 404 });
}

beforeEach(() => {
  session = sessionFor('session-1');
  callsBeforeExpiry = 0;
  serverError = false;
  failingReads = 0;
  failedReads = 0;
  signOutFails = false;
  unauthorizedAnswers = 0;
  reports = [];
  vi.stubGlobal('fetch', fakeServer);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const renderShell = async () => {
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
    const queryClient = await renderShell();

    await expectSignInPageWithNotice();
    expectSignedInCacheCleared(queryClient);
    // Not retried: asking again won't bring the session back.
    expect(unauthorizedAnswers).toBe(1);
  });

  it('returns to the sign-in page, with a notice, when an applications mutation answers 401', async () => {
    callsBeforeExpiry = 1;
    const queryClient = await renderShell();

    expect(await screen.findByRole('row', { name: /Acme/ })).toBeDefined();
    await userEvent.type(screen.getByLabelText('Company'), 'Globex');
    await userEvent.type(screen.getByLabelText('Job title'), 'Designer');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    await expectSignInPageWithNotice();
    expectSignedInCacheCleared(queryClient);
  });

  it('returns to the sign-in page, with a notice and no snackbar, when a status change answers 401', async () => {
    callsBeforeExpiry = 1;
    const queryClient = await renderShell();

    expect(await screen.findByRole('row', { name: /Acme/ })).toBeDefined();
    await userEvent.click(screen.getByRole('combobox', { name: 'Status for Acme' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Offer' }));

    await expectSignInPageWithNotice();
    expect(screen.queryAllByRole('alertdialog', { hidden: true })).toEqual([]);
    expectSignedInCacheCleared(queryClient);
  });

  it('shows the signed-in app once the user signs in again, and no notice after signing out', async () => {
    const queryClient = await renderShell();

    await expectSignInPageWithNotice();
    callsBeforeExpiry = 1;
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
    await renderShell();

    await expectSignInPageWithNotice();
    callsBeforeExpiry = 1;
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('row', { name: /Acme/ })).toBeDefined();

    // The new session ends on the server; Better Auth finds out when the tab is shown again.
    session = null;
    document.dispatchEvent(new Event('visibilitychange'));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeDefined();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('retries a read that fails for another reason, and shows the list once it succeeds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    failingReads = 1;
    callsBeforeExpiry = 1;
    await renderShell();

    await waitFor(() => expect(failingReads).toBe(0));
    // TanStack waits a second before its first retry.
    await vi.advanceTimersByTimeAsync(1000);

    expect(await screen.findByRole('row', { name: /Acme/ })).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDefined();
  });

  it('retries a read that keeps failing three times, then shows the error', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    failingReads = Number.POSITIVE_INFINITY;
    await renderShell();

    await waitFor(() => expect(failedReads).toBe(1));
    // TanStack waits 1 s, 2 s, then 4 s between retries.
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Something went wrong. Please try again.',
    );
    // Long past any further back-off: no fifth read.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failedReads).toBe(4);
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDefined();
  });

  it('keeps the user signed in, showing the error, when a sign-out fails', async () => {
    callsBeforeExpiry = 1;
    signOutFails = true;
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
    callsBeforeExpiry = 1;
    serverError = true;
    await renderShell();

    expect(await screen.findByRole('row', { name: /Acme/ })).toBeDefined();
    await userEvent.type(screen.getByLabelText('Company'), 'Globex');
    await userEvent.type(screen.getByLabelText('Job title'), 'Designer');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

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
    session = null;
    await renderShell();

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Report a problem' }));
    await screen.findByRole('alertdialog', { name: 'Report a problem' });
    expect(screen.getByLabelText<HTMLInputElement>('Reply email').value).toBe('');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await sendReport('GitHub sign-in failed');
    expect(reports).toEqual([
      { description: 'GitHub sign-in failed', replyEmail: null, pagePath: '/' },
    ]);
  });

  it('is in the footer when signed in, with the account email as the reply email', async () => {
    callsBeforeExpiry = 1;
    await renderShell();

    expect(await screen.findByRole('row', { name: /Acme/ })).toBeDefined();
    expect(
      within(screen.getByRole('contentinfo')).getByRole('button', { name: 'Report a problem' }),
    ).toBeDefined();

    await sendReport('The table is empty');
    expect(reports).toEqual([
      { description: 'The table is empty', replyEmail: 'ada@example.com', pagePath: '/' },
    ]);
    // Still signed in: the report has nothing to do with the session.
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDefined();
  });
});
