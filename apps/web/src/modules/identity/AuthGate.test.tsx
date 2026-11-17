import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

function fakeServer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const { pathname } = new URL(new Request(input, init).url);

  if (pathname === '/api/auth/get-session') {
    sessionChecks += 1;

    return Promise.resolve(Response.json(sessionChecks === 1 ? firstSession : null));
  }

  if (pathname === '/api/auth-config') return Promise.resolve(Response.json({ providers: [] }));

  return Promise.resolve(new Response(null, { status: 404 }));
}

beforeEach(() => {
  firstSession = signedIn;
  sessionChecks = 0;
  vi.stubGlobal('fetch', fakeServer);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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
      <identity.AuthGate>
        {({ userName, signOut }) => (
          <>
            <p>Signed in as {userName}</p>
            <button onClick={signOut}>Sign out</button>
          </>
        )}
      </identity.AuthGate>
    </QueryClientProvider>,
  );

  return { sessionEnded: identity.sessionEnded, queryClient };
};

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
    act(() => sessionEnded());
    await settle();
    expect(screen.queryByRole('status')).toBeNull();
    expect(sessionChecks).toBe(1);
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
