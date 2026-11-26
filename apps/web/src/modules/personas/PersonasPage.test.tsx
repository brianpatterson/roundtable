import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MAX_PERSONA_NAME, MAX_PERSONAS } from '@roundtable/contract';
import { describe, expect, it } from 'vitest';
import { setUpFakeApi } from '../../shared/testing/fake-api';
import { createTestRouter, TestRouterProvider } from '../../shared/testing/router';
import { PersonasPage, usePersonas } from './index';

// The page calls the real typed client, answered by the in-memory API (ADR-0071). The fake keeps
// Personas in name order but enforces no name rule or limit, so a 409 is an override.
const fake = setUpFakeApi();

const nameTaken = (archived: boolean) => () =>
  Response.json({ _tag: 'PersonaNameTaken', archived }, { status: 409 });

/** Every Persona `usePersonas` returns, by name: what another module would see. */
function PersonaNames() {
  const personas = usePersonas();

  return <output aria-label="Every persona">{personas.data?.map((p) => p.name).join(', ')}</output>;
}

const renderPage = async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  const router = createTestRouter(
    <>
      <PersonasPage />
      <PersonaNames />
    </>,
    '/personas',
  );

  render(
    <QueryClientProvider client={queryClient}>
      <TestRouterProvider router={router} />
    </QueryClientProvider>,
  );

  await screen.findByRole('textbox', { name: 'Persona name' });

  return router;
};

/** The active Personas, as the list reads them, in order: each one's name and Skill count. */
const activeRows = () =>
  within(screen.getByRole('list', { name: 'Personas' }))
    .getAllByRole('listitem')
    .map((item) => [...item.children].map((child) => child.textContent));

const nameField = () => screen.getByRole('textbox', { name: 'Persona name' });

const addPersona = async (name: string) => {
  await userEvent.type(nameField(), name);
  await userEvent.click(screen.getByRole('button', { name: 'Add persona' }));
};

describe('PersonasPage: no Personas', () => {
  it('explains what a Persona is for and offers the add form', async () => {
    await renderPage();

    expect(screen.getByRole('heading', { name: 'Personas' })).toBeDefined();
    expect(screen.getByText(/A persona is one way you present yourself/)).toBeDefined();
    expect(screen.getByRole('form', { name: 'Add a persona' })).toBeDefined();
    expect(screen.queryByRole('list', { name: 'Personas' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Archived/ })).toBeNull();
  });
});

describe('PersonasPage: the list', () => {
  it('lists the active Personas by name with their Skill counts, each linking to its page', async () => {
    const backend = fake.seedPersona({
      name: 'Backend engineer',
      skillIds: [fake.seedSkill({ name: 'Coding' }).id, fake.seedSkill({ name: 'SQL' }).id],
    });

    fake.seedPersona({ name: 'Architect', skillIds: [fake.seedSkill({ name: 'Design' }).id] });
    fake.seedPersona({ name: 'Manager' });
    const router = await renderPage();

    expect(activeRows()).toEqual([
      ['Architect', '1 skill'],
      ['Backend engineer', '2 skills'],
      ['Manager', '0 skills'],
    ]);

    const link = screen.getByRole('link', { name: 'Backend engineer' });

    expect(link.getAttribute('href')).toBe(`/personas/${backend.id}`);
    await userEvent.click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/personas/${backend.id}`));
  });

  it('keeps archived Personas in a collapsed Archived section, shown by its toggle', async () => {
    const old = fake.seedPersona({ name: 'Data analyst', archivedAt: new Date() });

    fake.seedPersona({ name: 'Backend engineer' });
    await renderPage();

    expect(activeRows()).toEqual([['Backend engineer', '0 skills']]);

    const toggle = screen.getByRole('button', { name: 'Archived (1)' });

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('list', { name: 'Archived' })).toBeNull();

    await userEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    const archived = screen.getByRole('list', { name: 'Archived' });

    expect(within(archived).getByRole('link', { name: 'Data analyst' }).getAttribute('href')).toBe(
      `/personas/${old.id}`,
    );
  });
});

describe('PersonasPage: adding', () => {
  it('adds the Persona in name order and clears the field', async () => {
    fake.seedPersona({ name: 'Backend engineer' });
    fake.seedPersona({ name: 'Manager' });
    await renderPage();

    await addPersona('  Frontend engineer  ');

    await waitFor(() =>
      expect(activeRows().map(([name]) => name)).toEqual([
        'Backend engineer',
        'Frontend engineer',
        'Manager',
      ]),
    );
    expect(fake.received('personas.create')).toEqual([{ name: 'Frontend engineer' }]);
    expect(nameField()).toHaveProperty('value', '');
  });

  it('replaces the empty state with the list once one is added', async () => {
    await renderPage();

    await addPersona('Backend engineer');

    await waitFor(() => expect(activeRows()).toEqual([['Backend engineer', '0 skills']]));
    expect(screen.queryByText(/A persona is one way you present yourself/)).toBeNull();
  });

  it.each([
    [false, 'You already have a persona with that name.'],
    [true, 'You have an archived persona with that name. Restore it instead.'],
  ])(
    'shows a taken name’s message by the field and keeps the text (archived: %s)',
    async (archived, message) => {
      fake.on('personas.create', nameTaken(archived));
      await renderPage();

      await addPersona('Manager');

      expect(await screen.findByText(message)).toBeDefined();
      expect(nameField()).toHaveProperty('value', 'Manager');
      expect(nameField().getAttribute('aria-invalid')).toBe('true');
      expect(nameField().getAttribute('aria-describedby')).toContain(screen.getByText(message).id);
    },
  );

  it('says a name of only spaces is blank, and sends nothing', async () => {
    await renderPage();

    await addPersona('   ');

    expect(await screen.findByText('Enter a persona name.')).toBeDefined();
    expect(nameField().getAttribute('aria-invalid')).toBe('true');
    expect(fake.received('personas.create')).toEqual([]);

    await userEvent.type(nameField(), 'Manager');

    expect(screen.queryByText('Enter a persona name.')).toBeNull();
  });

  it(`limits the name to ${MAX_PERSONA_NAME} characters`, async () => {
    await renderPage();

    expect(nameField().getAttribute('maxLength')).toBe(String(MAX_PERSONA_NAME));
  });

  it(`says the limit is reached, and disables the form, at ${MAX_PERSONAS} Personas`, async () => {
    for (let i = 0; i < MAX_PERSONAS; i += 1) {
      fake.seedPersona({ name: `Persona ${i}`, archivedAt: i % 2 ? new Date() : null });
    }

    await renderPage();

    expect(nameField()).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Add persona' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/You've reached the limit/)).toBeDefined();
  });

  it('keeps the form enabled, without the note, below the limit', async () => {
    for (let i = 0; i < MAX_PERSONAS - 1; i += 1) fake.seedPersona({ name: `Persona ${i}` });

    await renderPage();

    expect(nameField()).toHaveProperty('disabled', false);
    expect(screen.queryByText(/You've reached the limit/)).toBeNull();
  });
});

describe('usePersonas', () => {
  it('returns every Persona, archived ones included, and follows one added on the page', async () => {
    fake.seedPersona({ name: 'Data analyst', archivedAt: new Date() });
    fake.seedPersona({ name: 'Manager' });
    await renderPage();

    const every = screen.getByRole('status', { name: 'Every persona' });

    await waitFor(() => expect(every.textContent).toBe('Data analyst, Manager'));

    await addPersona('Backend engineer');

    await waitFor(() => expect(every.textContent).toBe('Backend engineer, Data analyst, Manager'));
    // One list for both: the page and the hook share the module's query.
    expect(fake.received('personas.list').length).toBeLessThanOrEqual(2);
  });
});
