import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
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

/** The same user signed in again: a new session. */
const signedInAgain = { ...signedIn, session: { ...signedIn.session, id: 'session-2' } };

type Session = typeof signedIn;

/** What the server answers for the session's first check. */
let firstSession: Session | null;

/** What it answers for each check after the first, in order; null (expired) once they run out. */
let laterSessions: (Session | null)[];

/** Checks after the first wait for this: a test can hold them back until `releaseRecheck()`. */
let recheckAnswered: Promise<void>;
let releaseRecheck: () => void;
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

    if (sessionChecks === 1) return Promise.resolve(Response.json(firstSession));

    const later = laterSessions[sessionChecks - 2] ?? null;

    return recheckAnswered.then(() => Response.json(later));
  }

  if (pathname === '/api/auth/sign-in/email') {
    return Promise.resolve(
      Response.json({ redirect: false, token: 'token-2', user: signedInAgain.user }),
    );
  }

  // Signed up, not yet confirmed: no session until the user follows the email's link.
  if (pathname === '/api/auth/sign-up/email') {
    return Promise.resolve(Response.json({ token: null, user: signedIn.user }));
  }

  if (pathname === '/api/auth/sign-out') {
    if (signOutUnreachable) return Promise.reject(new TypeError('Failed to fetch'));

    return signOutAnswered.then(() =>
      signOutStatus === 200
        ? Response.json({ success: true })
        : new Response(null, { status: signOutStatus }),
    );
  }

  if (pathname === '/api/auth-config') return Promise.resolve(Response.json({ providers }));

  if (pathname === '/api/auth/sign-in/social') {
    return new Request(input, init).text().then((body) => {
      socialSignIns.push(body);

      // No redirect: jsdom can't leave the page.
      return Response.json({ redirect: false });
    });
  }

  return Promise.resolve(new Response(null, { status: 404 }));
}

/** The sign-in providers the server offers. */
let providers: string[];

/** The JSON body of each social sign-in request. */
let socialSignIns: string[];

beforeEach(() => {
  firstSession = signedIn;
  laterSessions = [];
  recheckAnswered = Promise.resolve();
  sessionChecks = 0;
  signOutStatus = 200;
  signOutUnreachable = false;
  signOutAnswered = Promise.resolve();
  providers = [];
  socialSignIns = [];
  vi.stubGlobal('fetch', fakeServer());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Better Auth's session store unsubscribes from `window` a second after the last test unmounts
// it. Wait for that here, or it runs after jsdom has torn the window down and throws.
afterAll(() => new Promise((resolve) => setTimeout(resolve, 1100)));

/** Holds back the server's answer to every session check after the first. */
const holdRechecks = () => {
  recheckAnswered = new Promise((resolve) => {
    releaseRecheck = resolve;
  });
};

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

  it('keeps the sign-up page and its notice while the session is re-checked after signing up', async () => {
    firstSession = null;
    await renderGate();

    await userEvent.click(await screen.findByRole('button', { name: 'Create an account' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Ada');
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText(/^Password/), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

    // Better Auth re-checks the session after a sign-up; no session yet, the email isn't confirmed.
    await vi.waitFor(() => expect(sessionChecks).toBe(2));
    await settle();
    expect(screen.getByRole('heading', { name: 'Create an account' })).toBeDefined();
    expect(
      screen.getByText('Check ada@example.com for a link to finish creating your account.'),
    ).toBeDefined();
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('returns a social sign-in to the page that was opened, and a failed one to the start', async () => {
    firstSession = null;
    providers = ['github'];
    window.history.replaceState(null, '', '/applications/a1');

    try {
      await renderGate();

      await userEvent.click(await screen.findByRole('button', { name: 'Continue with GitHub' }));

      await waitFor(() => expect(socialSignIns).toHaveLength(1));
      expect(JSON.parse(socialSignIns[0] ?? '')).toMatchObject({
        provider: 'github',
        callbackURL: '/applications/a1',
        errorCallbackURL: '/',
      });
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

  it('re-checks the session once when more requests answer 401 before the re-check answers', async () => {
    holdRechecks();
    const { sessionEnded, queryClient } = await renderGate();

    expect(await screen.findByText('Signed in as Ada')).toBeDefined();
    act(() => sessionEnded());
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeDefined();
    await vi.waitFor(() => expect(sessionChecks).toBe(2));
    queryClient.setQueryData(['sign-in-data'], 'cached');
    // Better Auth still holds the ended session: another request answers 401 meanwhile.
    act(() => sessionEnded());
    act(() => releaseRecheck());
    await settle();

    expect(sessionChecks).toBe(2);
    expect(queryClient.getQueryData(['sign-in-data'])).toBe('cached');
    expect(screen.getByRole('status').textContent).toBe('You were signed out. Sign in again.');
  });

  it('keeps an ended session signed out when a later check still answers with it', async () => {
    laterSessions = [null, signedIn];
    const { sessionEnded } = await renderGate();

    expect(await screen.findByText('Signed in as Ada')).toBeDefined();
    act(() => sessionEnded());
    await vi.waitFor(() => expect(sessionChecks).toBe(2));
    await settle();
    // The tab is shown again, and the server answers with the session the API stopped accepting.
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await vi.waitFor(() => expect(sessionChecks).toBe(3));
    await settle();

    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeDefined();
    expect(screen.getByRole('status').textContent).toBe('You were signed out. Sign in again.');
    expect(screen.queryByText('Signed in as Ada')).toBeNull();
  });

  it('forgets a failed sign-out once the session expires and the user signs in again', async () => {
    signOutStatus = 500;
    laterSessions = [null, signedInAgain];
    const { sessionEnded } = await renderGate();

    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alert')).toBeDefined();
    act(() => sessionEnded());
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeDefined();
    await vi.waitFor(() => expect(sessionChecks).toBe(2));
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Signed in as Ada')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
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

  it('shows the sign-in page once sign-out succeeds, before the session re-check answers, and re-checks once', async () => {
    holdRechecks();
    await renderGate();

    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));

    // Better Auth still holds the session until its re-check answers: the gate doesn't wait for it.
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeDefined();
    expect(screen.queryByText('Signed in as Ada')).toBeNull();
    act(() => releaseRecheck());
    await settle();
    expect(sessionChecks).toBe(2);
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
    // A problem report sent now would say so (ADR-0041): the request never got an answer. The
    // same module instance the gate loaded, after resetModules.
    const { collectDiagnostics } = await import('../../shared/diagnostics');

    expect(collectDiagnostics().requests).toContainEqual(
      expect.objectContaining({ method: 'POST', path: '/api/auth/sign-out', status: 0 }),
    );
  });

  it('clears the sign-out error when the user tries again and succeeds', async () => {
    signOutStatus = 500;
    await renderGate();

    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alert')).toBeDefined();
    signOutStatus = 200;
    signOutAnswered = new Promise((resolve) => {
      releaseSignOut = resolve;
    });
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    // Gone as soon as the user tries again, before the server answers.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Signed in as Ada')).toBeDefined();
    act(() => releaseSignOut());

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
