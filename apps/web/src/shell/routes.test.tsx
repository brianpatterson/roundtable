import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The app's pages (ADR-0049), through the whole shell at the browser's own URL, against a
// stand-in `fetch`: signing in, the applications table and each application's page.
const ACME_ID = '00000000-0000-4000-8000-000000000001';
const MISSING_ID = '00000000-0000-4000-8000-000000000009';

const user = {
  id: 'user-1',
  name: 'Ada',
  email: 'ada@example.com',
  emailVerified: true,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

const sessionFor = (id: string) => ({
  session: {
    id,
    userId: user.id,
    token: `token-${id}`,
    expiresAt: '2026-12-01T00:00:00.000Z',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  },
  user,
});

/** The server's session: null when signed out, or once it has expired. */
let session: ReturnType<typeof sessionFor> | null;

/** The session expires at the next applications call. */
let expires: boolean;

/** Acme's application as the API sends it, in `status`. */
const acmeIn = (status: string) => ({
  id: ACME_ID,
  company: 'Acme',
  jobTitle: 'Engineer',
  jobUrl: null,
  status,
  appliedAt: '2026-10-30T12:00:00.000Z',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-02T00:00:00.000Z',
});

/** The user's one application, as the server holds it. */
let acme: ReturnType<typeof acmeIn>;

async function fakeServer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const { pathname } = new URL(request.url);

  if (pathname === '/api/auth/get-session') return Response.json(session);

  if (pathname === '/api/auth/sign-in/email') {
    session = sessionFor('session-2');

    return Response.json({ redirect: false, token: session.session.token, user });
  }

  if (pathname === '/api/auth-config') return Response.json({ providers: [] });

  if (!pathname.startsWith('/api/applications')) return new Response(null, { status: 404 });

  // The session runs out: this call is refused, and Better Auth's next check finds no session.
  if (expires) session = null;

  if (!session) return Response.json({ _tag: 'Unauthorized' }, { status: 401 });

  if (pathname === '/api/applications') return Response.json([acme]);

  if (pathname !== `/api/applications/${acme.id}`)
    return Response.json({ _tag: 'ApplicationNotFound' }, { status: 404 });

  if (request.method === 'PATCH') {
    // SAFETY: the typed client encoded this body with the contract's UpdateApplication schema.
    const { status } = (await request.json()) as { status: string };

    acme = acmeIn(status);
  }

  return Response.json(acme);
}

beforeEach(() => {
  session = sessionFor('session-1');
  expires = false;
  acme = acmeIn('applied');
  vi.stubGlobal('fetch', fakeServer);
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

// Better Auth's session store unsubscribes from `window` a second after the last test unmounts
// it. Wait for that here, or it runs after jsdom has torn the window down and throws.
afterAll(() => new Promise((resolve) => setTimeout(resolve, 1100)));

/** Opens the app at `path`, as typing it in the address bar (or reloading it) would. */
const openApp = async (path = '/') => {
  window.history.replaceState(null, '', path);
  // Better Auth keeps the session in a store created with the client, which outlives a test.
  // Fresh modules give each test a new one (see App.test.tsx).
  vi.resetModules();
  const { App } = await import('./App');
  const { createQueryClient } = await import('./Providers');
  const { SnackbarProvider, ThemeProvider, createSnackbars } = await import('../design-system');
  const { QueryClientProvider } = await import('@tanstack/react-query');
  const snackbars = createSnackbars();

  render(
    <ThemeProvider>
      <SnackbarProvider snackbars={snackbars}>
        <QueryClientProvider client={createQueryClient(snackbars)}>
          <App />
        </QueryClientProvider>
      </SnackbarProvider>
    </ThemeProvider>,
  );
};

const findApplicationPage = async (company = 'Acme') => {
  expect(await screen.findByRole('heading', { name: company })).toBeDefined();
  expect(window.location.pathname).toBe(`/applications/${ACME_ID}`);
};

const findTable = async () => {
  expect(await screen.findByRole('table')).toBeDefined();
  expect(window.location.pathname).toBe('/');
};

describe('App: an application’s page', () => {
  it('opens from the company name in the table, and the back button returns to the table', async () => {
    await openApp();

    await userEvent.click(await screen.findByRole('link', { name: 'Acme' }));

    await findApplicationPage();
    expect(screen.getByText('Engineer')).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();

    window.history.back();

    await findTable();
  });

  it('returns to the table through its link back to the applications', async () => {
    await openApp(`/applications/${ACME_ID}`);

    await findApplicationPage();
    await userEvent.click(screen.getByRole('link', { name: 'Back to my applications' }));

    await findTable();
  });

  it('shows the application when its URL is opened directly or reloaded', async () => {
    await openApp(`/applications/${ACME_ID}`);

    await findApplicationPage();
    // The signed-in layout is still around it.
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDefined();
  });

  it('asks a signed-out user to sign in, then shows the application they opened', async () => {
    session = null;
    await openApp(`/applications/${ACME_ID}`);

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeDefined();
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await findApplicationPage();
  });

  it.each([
    ['one that doesn’t exist', MISSING_ID],
    ['a malformed id', 'not-an-id'],
  ])('says the application is not found for %s, with a way back', async (_, id) => {
    await openApp(`/applications/${id}`);

    expect(await screen.findByRole('heading', { name: 'Application not found' })).toBeDefined();
    await userEvent.click(screen.getByRole('link', { name: 'Back to my applications' }));

    await findTable();
  });

  it('shows a change made in the table', async () => {
    await openApp();

    // Seen once before the change, so a stale copy would be in the cache.
    await userEvent.click(await screen.findByRole('link', { name: 'Acme' }));
    await findApplicationPage();
    window.history.back();
    await findTable();

    await userEvent.click(screen.getByRole('combobox', { name: 'Status for Acme' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Offer' }));
    await waitFor(() => expect(acme.status).toBe('offer'));

    await userEvent.click(screen.getByRole('link', { name: 'Acme' }));
    await findApplicationPage();

    const status = screen.getByText('Status').nextElementSibling;

    await waitFor(() => expect(status?.textContent).toBe('Offer'));
  });

  it('returns to sign-in with a notice when the session has expired, as the table does', async () => {
    expires = true;
    await openApp(`/applications/${ACME_ID}`);

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeDefined();
    expect(screen.getByRole('status').textContent).toBe('You were signed out. Sign in again.');
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });
});

describe('App: an unknown path', () => {
  it('shows a not-found page with a link to the applications', async () => {
    await openApp('/no-such-page');

    const main = await screen.findByRole('main');

    expect(await within(main).findByRole('heading', { name: 'Page not found' })).toBeDefined();
    await userEvent.click(screen.getByRole('link', { name: 'Back to my applications' }));

    await findTable();
  });
});
