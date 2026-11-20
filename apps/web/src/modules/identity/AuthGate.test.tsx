import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Identity through its interface (index.ts): the gate, and `sessionEnded`, which the shell calls
// for every Unauthorized answer. Only Better Auth's server is a stand-in, behind `fetch`.
const signedIn = {
  session: {
    id: 'session-1',
    userId: 'user-1',
    token: 'token-1',
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
};

/** What the server answers for the session; each answer after the first is null (expired). */
let firstSession: typeof signedIn | null;
let sessionChecks: number;

/** What the server answers for sign-out; a test can hold it back until `releaseSignOut()`. */
let signOutStatus: number;

/** The sign-out request never reaches the server (no connection). */
let signOutUnreachable: boolean;
let signOutAnswered: Promise<void>;
let releaseSignOut: () => void;

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** The fake server of the running test. */
let currentServer: Fetch | undefined;

/**
 * A fake server for one test. Better Auth's client keeps the `fetch` it was created with, and an
 * earlier test's client can still re-check its session for a moment after that test: its requests
 * go nowhere, so they can't count as this test's.
 */
function fakeServer(): Fetch {
  const server: Fetch = (input, init) =>
    server === currentServer
      ? answer(input, init)
      : Promise.reject(new TypeError('Failed to fetch'));

  currentServer = server;

  return server;
}

function answer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const { pathname } = new URL(new Request(input, init).url);

  if (pathname === '/api/auth/get-session') {
    sessionChecks += 1;

    return Promise.resolve(Response.json(sessionChecks === 1 ? firstSession : null));
  }

  if (pathname === '/api/auth/sign-out') {
    if (signOutUnreachable) return Promise.reject(new TypeError('Failed to fetch'));

    return signOutAnswered.then(() =>
      signOutStatus === 200
        ? Response.json({ success: true })
        : new Response(null, { status: signOutStatus }),
    );
  }

  if (pathname === '/api/auth-config') return Promise.resolve(Response.json({ providers: [] }));

  return Promise.resolve(new Response(null, { status: 404 }));
}

beforeEach(() => {
  firstSession = signedIn;
  sessionChecks = 0;
  signOutStatus = 200;
  signOutUnreachable = false;
  signOutAnswered = Promise.resolve();
  vi.stubGlobal('fetch', fakeServer());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Better Auth's session store unsubscribes from `window` a second after the last test unmounts
// it. Wait for that here, or it runs after jsdom has torn the window down and throws.
afterAll(() => new Promise((resolve) => setTimeout(resolve, 1100)));

/** Lets any request the gate would make go out, so a test can check it didn't. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));

const renderGate = async () => {
  // Better Auth's session store is created with the client and outlives a test: fresh modules
  // give each test its own.
  vi.resetModules();
  const identity = await import('./index');
  const queryClient = new QueryClient();

  queryClient.setQueryData(['signed-in-data'], 'cached');
  render(
    <QueryClientProvider client={queryClient}>
      <identity.AuthGate signedOut={<p>Signed-out extra</p>}>
        {({ userName, userEmail, signOut, signOutError }) => (
          <>
            <p>Signed in as {userName}</p>
            <p>Email {userEmail}</p>
            <button onClick={signOut}>Sign out</button>
            {signOutError && <p role="alert">{signOutError}</p>}
          </>
        )}
      </identity.AuthGate>
    </QueryClientProvider>,
  );

  return { sessionEnded: identity.sessionEnded, queryClient };
};

describe('AuthGate: what it shows', () => {
  it('gives the signed-in view the user’s name and email, without the signed-out extra', async () => {
    await renderGate();

    expect(await screen.findByText('Signed in as Ada')).toBeDefined();
    expect(screen.getByText('Email ada@example.com')).toBeDefined();
    expect(screen.queryByText('Signed-out extra')).toBeNull();
  });

  it('shows the signed-out extra under the sign-in page', async () => {
    firstSession = null;
    await renderGate();

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeDefined();
    expect(screen.getByText('Signed-out extra')).toBeDefined();
  });

  it('shows the signed-out extra under the password-reset page', async () => {
    window.history.replaceState(null, '', '/reset-password?token=abc');

    try {
      await renderGate();

      expect(await screen.findByText('Signed-out extra')).toBeDefined();
      expect(screen.queryByText('Signed in as Ada')).toBeNull();
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });
});

describe('AuthGate: session ended', () => {
  it('shows the sign-in page with a notice, clears the cache and re-checks the session once', async () => {
    const { sessionEnded, queryClient } = await renderGate();

    expect(await screen.findByText('Signed in as Ada')).toBeDefined();
    act(() => {
      sessionEnded();
      sessionEnded();
    });

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeDefined();
    expect(screen.getByRole('status').textContent).toBe('You were signed out. Sign in again.');
    expect(screen.queryByText('Signed in as Ada')).toBeNull();
    expect(queryClient.getQueryData(['signed-in-data'])).toBeUndefined();
    await vi.waitFor(() => expect(sessionChecks).toBe(2));
    await settle();
    expect(sessionChecks).toBe(2);
  });

  it("leaves the sign-in page's cache alone when a late request fails after the session ended", async () => {
    const { sessionEnded, queryClient } = await renderGate();

    expect(await screen.findByText('Signed in as Ada')).toBeDefined();
    act(() => sessionEnded());
    await vi.waitFor(() => expect(sessionChecks).toBe(2));
    await settle();
    queryClient.setQueryData(['sign-in-data'], 'cached');
    act(() => sessionEnded());

    expect(queryClient.getQueryData(['sign-in-data'])).toBe('cached');
    expect(screen.getByRole('status').textContent).toBe('You were signed out. Sign in again.');
  });

  it('signs out to the sign-in page without the notice, clearing the cache', async () => {
    const { sessionEnded, queryClient } = await renderGate();

    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeDefined();
    expect(queryClient.getQueryData(['signed-in-data'])).toBeUndefined();
    // A request that was in flight when the user signed out answers 401: still no notice.
    await settle();
    const checksAfterSignOut = sessionChecks;
    act(() => sessionEnded());
    await settle();
    expect(screen.queryByRole('status')).toBeNull();
    expect(sessionChecks).toBe(checksAfterSignOut);
  });

  it('shows no notice when a request answers 401 while the sign-out request is in flight', async () => {
    signOutAnswered = new Promise((resolve) => {
      releaseSignOut = resolve;
    });
    const { sessionEnded, queryClient } = await renderGate();

    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    act(() => sessionEnded());
    // Still signed in until the server answers: the cache is untouched and nothing re-checks.
    expect(screen.getByText('Signed in as Ada')).toBeDefined();
    expect(queryClient.getQueryData(['signed-in-data'])).toBe('cached');
    await settle();
    expect(sessionChecks).toBe(1);
    act(() => releaseSignOut());

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeDefined();
    expect(screen.queryByRole('status')).toBeNull();
    expect(queryClient.getQueryData(['signed-in-data'])).toBeUndefined();
  });

  it('stays signed in, with an error, when the sign-out request answers 500', async () => {
    signOutStatus = 500;
    const { sessionEnded, queryClient } = await renderGate();

    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      "Couldn't sign out. Check your connection and try again.",
    );
    expect(screen.getByText('Signed in as Ada')).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull();
    expect(queryClient.getQueryData(['signed-in-data'])).toBe('cached');

    // The session still counts as signed in: if it does expire later, that's reported as usual.
    act(() => sessionEnded());
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeDefined();
    expect(screen.getByRole('status').textContent).toBe('You were signed out. Sign in again.');
  });

  it('stays signed in, with an error, when the sign-out request cannot reach the server', async () => {
    // Through the fake server: Better Auth's client keeps the `fetch` it was created with.
    signOutUnreachable = true;
    const { queryClient } = await renderGate();

    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      "Couldn't sign out. Check your connection and try again.",
    );
    expect(screen.getByText('Signed in as Ada')).toBeDefined();
    expect(queryClient.getQueryData(['signed-in-data'])).toBe('cached');
  });

  it('clears the sign-out error when the user tries again and succeeds', async () => {
    signOutStatus = 500;
    await renderGate();

    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alert')).toBeDefined();
    signOutStatus = 200;
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('changes nothing when the user is already signed out', async () => {
    firstSession = null;
    const { sessionEnded, queryClient } = await renderGate();

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeDefined();
    act(() => sessionEnded());

    expect(screen.queryByRole('status')).toBeNull();
    expect(queryClient.getQueryData(['signed-in-data'])).toBe('cached');
    await settle();
    expect(sessionChecks).toBe(1);
  });
});
