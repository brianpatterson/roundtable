import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setUpFakeApi } from '../shared/testing/fake-api';

// The app's pages (ADR-0049), through the whole shell at the browser's own URL, against the
// in-memory API: signing in, the applications table and each application's page.
const fake = setUpFakeApi();

const ACME_ID = '00000000-0000-4000-8000-000000000001';
const MISSING_ID = '00000000-0000-4000-8000-000000000009';

beforeEach(() => {
  fake.seedApplication({ id: ACME_ID, company: 'Acme', jobTitle: 'Engineer' });
  // Unscheduled, so the Agenda reads the same whenever the test runs.
  fake.seedRound(ACME_ID);
});

afterEach(() => {
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
  expect(window.location.pathname).toBe('/applications');
};

const findAgenda = async () => {
  expect(await screen.findByRole('heading', { name: 'Agenda' })).toBeDefined();
  expect(window.location.pathname).toBe('/');
};

/** Which of the header's links is marked as the current page, by name. */
const currentPages = () =>
  within(screen.getByRole('navigation', { name: 'Pages' }))
    .getAllByRole('link')
    .filter((link) => link.getAttribute('aria-current') === 'page')
    .map((link) => link.textContent);

describe('App: the Agenda and the Applications table', () => {
  it('shows the Agenda at /, marked as the current page', async () => {
    await openApp('/');

    await findAgenda();
    expect(await screen.findByRole('link', { name: 'Acme – Engineer' })).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
    expect(currentPages()).toEqual(['Agenda']);
  });

  it('shows the Applications table at /applications, marked as the current page', async () => {
    await openApp('/applications');

    await findTable();
    expect(screen.queryByRole('heading', { name: 'Agenda' })).toBeNull();
    expect(currentPages()).toEqual(['Applications']);
  });

  it('shows the Skills page at /skills, marked as the current page, linked beside the others', async () => {
    fake.seedSkill({ name: 'System design' });
    await openApp('/');
    await findAgenda();

    const nav = screen.getByRole('navigation', { name: 'Pages' });

    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Agenda', 'Applications', 'Skills']);

    await userEvent.click(within(nav).getByRole('link', { name: 'Skills' }));
    expect(await screen.findByRole('heading', { name: 'Skills' })).toBeDefined();
    expect(window.location.pathname).toBe('/skills');
    expect(currentPages()).toEqual(['Skills']);
    expect(await screen.findByText('System design')).toBeDefined();
  });

  it('goes between them through the header, and marks neither on an application’s page', async () => {
    await openApp('/');
    await findAgenda();

    await userEvent.click(screen.getByRole('link', { name: 'Applications' }));
    await findTable();
    expect(currentPages()).toEqual(['Applications']);

    await userEvent.click(screen.getByRole('link', { name: 'Agenda' }));
    await findAgenda();
    expect(currentPages()).toEqual(['Agenda']);

    await userEvent.click(await screen.findByRole('link', { name: 'Acme – Engineer' }));
    await findApplicationPage();
    expect(currentPages()).toEqual([]);

    await userEvent.click(screen.getByRole('link', { name: 'Agenda' }));
    await findAgenda();
  });
});

describe('App: an application’s page', () => {
  it('opens from the company name in the table, and the back button returns to the table', async () => {
    await openApp('/applications');

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
    fake.endSession();
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
    await openApp('/applications');

    // Seen once before the change, so a stale copy would be in the cache.
    await userEvent.click(await screen.findByRole('link', { name: 'Acme' }));
    await findApplicationPage();
    window.history.back();
    await findTable();

    await userEvent.click(screen.getByRole('combobox', { name: 'Status for Acme' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Offer' }));
    await waitFor(() => expect(fake.application(ACME_ID)?.status).toBe('offer'));

    await userEvent.click(screen.getByRole('link', { name: 'Acme' }));
    await findApplicationPage();

    const status = screen.getByText('Status').nextElementSibling;

    await waitFor(() => expect(status?.textContent).toBe('Offer'));
  });

  it('returns to sign-in with a notice when the session has expired, as the table does', async () => {
    // The session runs out at the next call: it's refused, and Better Auth then finds none.
    fake.expireSessionAfter(0);
    await openApp(`/applications/${ACME_ID}`);

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeDefined();
    expect(screen.getByRole('status').textContent).toBe('You were signed out. Sign in again.');
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });
});

describe('App: an unknown path', () => {
  it('shows a not-found page, with the header, and a link back to the Agenda', async () => {
    await openApp('/no-such-page');

    const main = await screen.findByRole('main');

    expect(await within(main).findByRole('heading', { name: 'Page not found' })).toBeDefined();
    expect(currentPages()).toEqual([]);
    await userEvent.click(screen.getByRole('link', { name: 'Back to the agenda' }));

    await findAgenda();
  });
});
