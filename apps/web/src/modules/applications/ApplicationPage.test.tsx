import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { SnackbarProvider, createSnackbars } from '../../design-system';
import { serverError, setUpFakeApi } from '../../shared/testing/fake-api';
import { createTestRouter, TestRouterProvider } from '../../shared/testing/router';
import { PersonaPage } from '../personas';
import { ApplicationPage } from './ApplicationPage';

// The page calls the real typed client, answered by the in-memory API. Its Rounds have their
// own tests (Rounds.test.tsx).
const fake = setUpFakeApi();

const ACME_ID = '00000000-0000-4000-8000-000000000001';
const MISSING_ID = '00000000-0000-4000-8000-000000000009';

const APPLIED_AT = '2026-10-30T12:00:00.000Z';

beforeEach(() => {
  fake.seedApplication({
    id: ACME_ID,
    status: 'interviewing',
    appliedAt: new Date(APPLIED_AT),
    jobUrl: 'https://jobs.example.com/acme/1',
  });
});

/** The endpoints the page called, in order. */
const called = () => fake.calls().map((call) => call.endpoint);

const renderPage = (
  applicationId: string,
  page: ReactNode = <ApplicationPage applicationId={applicationId} />,
) => {
  // The shell's cache shows an opted-in mutation's errors in a snackbar; this does the same.
  const appSnackbars = createSnackbars();

  const queryClient = new QueryClient({
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (mutation.meta?.errorSnackbar) appSnackbars.show(error.message);
      },
    }),
    defaultOptions: { queries: { retry: false } },
  });

  const router = createTestRouter(page, '/elsewhere');

  render(
    <SnackbarProvider snackbars={appSnackbars}>
      <QueryClientProvider client={queryClient}>
        <TestRouterProvider router={router} />
      </QueryClientProvider>
    </SnackbarProvider>,
  );

  return router;
};

/** The page's fields, as label → value. */
const fields = () => {
  const labels = screen.getAllByRole('term').map((term) => term.textContent);
  const values = screen.getAllByRole('definition').map((value) => value.textContent);

  return Object.fromEntries(labels.map((label, i) => [label, values[i]]));
};

const expectNotFound = async () => {
  expect(await screen.findByRole('heading', { name: 'Application not found' })).toBeDefined();
  expect(screen.getByRole('link', { name: 'Back to my applications' }).getAttribute('href')).toBe(
    '/applications',
  );
  expect(screen.queryByText('Acme')).toBeNull();
};

describe('ApplicationPage', () => {
  it('shows the application’s company, job title, job link, status and applied date', async () => {
    renderPage(ACME_ID);

    expect(await screen.findByRole('heading', { name: 'Acme' })).toBeDefined();
    await screen.findByRole('link', { name: 'Add a persona' });
    expect(fields()).toEqual({
      'Job title': 'Engineer',
      'Job link': 'https://jobs.example.com/acme/1',
      Status: 'Interviewing',
      Applied: new Date(APPLIED_AT).toLocaleDateString(),
      Persona: 'None. Add a persona',
    });

    const jobLink = screen.getByRole('link', { name: 'https://jobs.example.com/acme/1' });

    expect(jobLink.getAttribute('href')).toBe('https://jobs.example.com/acme/1');
    // A page outside the app opens in its own tab, without access to this one.
    expect(jobLink.getAttribute('target')).toBe('_blank');
    expect(jobLink.getAttribute('rel')).toBe('noreferrer');
  });

  it('shows a saved application as Not sent, with no job link when it has none', async () => {
    fake.changeApplication(ACME_ID, { status: 'saved', appliedAt: null, jobUrl: null });
    renderPage(ACME_ID);

    expect(await screen.findByRole('heading', { name: 'Acme' })).toBeDefined();
    await screen.findByRole('link', { name: 'Add a persona' });
    expect(fields()).toEqual({
      'Job title': 'Engineer',
      Status: 'Saved',
      Applied: 'Not sent',
      Persona: 'None. Add a persona',
    });
  });

  it('links back to the applications', async () => {
    const router = renderPage(ACME_ID);

    await screen.findByRole('heading', { name: 'Acme' });
    await userEvent.click(screen.getByRole('link', { name: 'Back to my applications' }));

    expect(router.state.location.pathname).toBe('/applications');
  });

  it('says the application is not found when the server has none with that id', async () => {
    renderPage(MISSING_ID);

    await expectNotFound();
    // An answer, not a failure: no error, and asked only once.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(called()).toEqual(['applications.get']);
    expect(fake.received('applications.get')).toEqual([{ id: MISSING_ID }]);
  });

  it('says a malformed id is not found, without asking the server', async () => {
    renderPage('not-an-id');

    await expectNotFound();
    expect(called()).toEqual([]);
  });

  it('shows any other failure as an error, with the way back', async () => {
    // A 500 has nothing to do with the application.
    fake.on('applications.get', serverError);
    fake.on('applications.listRounds', serverError);
    renderPage(ACME_ID);

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Something went wrong. Please try again.',
    );
    expect(screen.queryByRole('heading', { name: 'Application not found' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to my applications' })).toBeDefined();
  });

  it('shows loading until the server answers', async () => {
    renderPage(ACME_ID);

    expect(await screen.findByText('Loading…')).toBeDefined();
    expect(await screen.findByRole('heading', { name: 'Acme' })).toBeDefined();
    // The Persona row waits for the Personas, which come separately.
    expect(await screen.findByRole('link', { name: 'Add a persona' })).toBeDefined();
    expect(screen.queryByText('Loading…')).toBeNull();
  });
});

describe('ApplicationPage: Persona', () => {
  const personaSelect = () => screen.findByRole('combobox', { name: 'Persona' });

  /** The Persona picker's options, by name. */
  const personaOptions = async () => {
    await userEvent.click(await personaSelect());

    const names = (await screen.findAllByRole('option')).map((option) => option.textContent);

    await userEvent.keyboard('{Escape}');

    return names;
  };

  const pickPersona = async (name: string) => {
    await userEvent.click(await personaSelect());
    await userEvent.click(await screen.findByRole('option', { name }));
  };

  /** The polite snackbar's text: a confirmation, not an error. */
  const confirmation = async () =>
    (await screen.findByRole('dialog', { hidden: true })).textContent;

  const personaOf = () => fake.application(ACME_ID)?.personaId;

  it('offers None and the active Personas by name, without archived ones', async () => {
    fake.seedPersona({ name: 'Platform engineer' });
    fake.seedPersona({ name: 'Backend engineer' });
    fake.seedPersona({ name: 'Designer', archivedAt: new Date() });
    renderPage(ACME_ID);

    expect((await personaSelect()).textContent).toContain('None');
    expect(await personaOptions()).toEqual(['None', 'Backend engineer', 'Platform engineer']);
  });

  it('offers the Application’s own Persona if it’s archived, labeled so', async () => {
    fake.seedPersona({ name: 'Backend engineer' });
    const designer = fake.seedPersona({ name: 'Designer', archivedAt: new Date() });

    fake.changeApplication(ACME_ID, { personaId: designer.id });
    renderPage(ACME_ID);

    await waitFor(async () =>
      expect((await personaSelect()).textContent).toContain('Designer (archived)'),
    );
    expect(await personaOptions()).toEqual(['None', 'Backend engineer', 'Designer (archived)']);
  });

  it('saves the Persona the user picks and confirms it', async () => {
    const backend = fake.seedPersona({ name: 'Backend engineer' });

    renderPage(ACME_ID);
    await pickPersona('Backend engineer');

    await waitFor(() => expect(personaOf()).toBe(backend.id));
    expect(fake.received('applications.update')).toEqual([{ personaId: backend.id }]);
    expect(await confirmation()).toContain('Persona set to Backend engineer.');
    expect((await personaSelect()).textContent).toContain('Backend engineer');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('clears the Persona when the user picks None', async () => {
    const backend = fake.seedPersona({ name: 'Backend engineer' });

    fake.changeApplication(ACME_ID, { personaId: backend.id });
    renderPage(ACME_ID);
    await waitFor(async () =>
      expect((await personaSelect()).textContent).toContain('Backend engineer'),
    );
    await pickPersona('None');

    await waitFor(() => expect(personaOf()).toBeNull());
    expect(fake.received('applications.update')).toEqual([{ personaId: null }]);
    expect(await confirmation()).toContain('Persona cleared.');
  });

  it('reads None with a link to the Personas when the user has none', async () => {
    const router = renderPage(ACME_ID);

    await userEvent.click(await screen.findByRole('link', { name: 'Add a persona' }));

    expect(screen.queryByRole('combobox', { name: 'Persona' })).toBeNull();
    expect(router.state.location.pathname).toBe('/personas');
  });

  it('keeps the picker when every Persona is archived', async () => {
    fake.seedPersona({ name: 'Designer', archivedAt: new Date() });
    renderPage(ACME_ID);

    expect(await personaOptions()).toEqual(['None']);
    expect(screen.queryByRole('link', { name: 'Add a persona' })).toBeNull();
  });

  it('goes back to the stored Persona and shows why when saving fails', async () => {
    fake.seedPersona({ name: 'Backend engineer' });
    // Archived in another tab after the page loaded.
    fake.on('applications.update', () =>
      Response.json({ _tag: 'PersonaArchived' }, { status: 409 }),
    );
    renderPage(ACME_ID);
    await pickPersona('Backend engineer');

    expect((await screen.findByRole('alert')).textContent).toBe(
      'That persona is archived. Restore it to pick it.',
    );
    await waitFor(async () => expect((await personaSelect()).textContent).toContain('None'));
    expect(personaOf()).toBeNull();
  });

  it('shows a Persona’s new name once it’s renamed, without reloading', async () => {
    const backend = fake.seedPersona({ name: 'Backend engineer' });

    fake.changeApplication(ACME_ID, { personaId: backend.id });
    renderPage(
      ACME_ID,
      <>
        <ApplicationPage applicationId={ACME_ID} />
        <PersonaPage personaId={backend.id} />
      </>,
    );
    await waitFor(async () =>
      expect((await personaSelect()).textContent).toContain('Backend engineer'),
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Rename' }));
    const name = await screen.findByLabelText('Name');

    await userEvent.clear(name);
    await userEvent.type(name, 'Staff engineer');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () =>
      expect((await personaSelect()).textContent).toContain('Staff engineer'),
    );
    expect(fake.calls().filter((call) => call.endpoint === 'applications.get')).toHaveLength(1);
  });
});
