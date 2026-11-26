import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MAX_PERSONA_NAME, MAX_PERSONA_SKILLS } from '@roundtable/contract';
import { describe, expect, it } from 'vitest';
import { SnackbarProvider, createSnackbars } from '../../design-system';
import { serverError, setUpFakeApi } from '../../shared/testing/fake-api';
import { createTestRouter, TestRouterProvider } from '../../shared/testing/router';
import { PersonaPage } from './index';

// The page calls the real typed client, answered by the in-memory API (ADR-0071). The fake stores
// what it's told and enforces no limit or name rule, so a 409 or a 400 is an override.
const fake = setUpFakeApi();

const MISSING_ID = '00000000-0000-4000-8000-000000000009';

const renderPage = (personaId: string) => {
  const appSnackbars = createSnackbars();

  // The shell's cache shows an opted-in mutation's errors in a snackbar; this does the same.
  const queryClient = new QueryClient({
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (mutation.meta?.errorSnackbar) appSnackbars.show(error.message);
      },
    }),
    defaultOptions: { queries: { retry: false } },
  });

  const router = createTestRouter(<PersonaPage personaId={personaId} />, '/elsewhere');

  render(
    <SnackbarProvider snackbars={appSnackbars}>
      <QueryClientProvider client={queryClient}>
        <TestRouterProvider router={router} />
      </QueryClientProvider>
    </SnackbarProvider>,
  );

  return router;
};

const skillsGroup = () => screen.getByRole('group', { name: 'Skills' });

/** The Skill checkboxes, by label, each with whether it's ticked. */
const boxes = () =>
  within(skillsGroup())
    .getAllByRole('checkbox')
    .map((box) => [box.closest('label')?.textContent, box.getAttribute('aria-checked')]);

const box = (name: string) => within(skillsGroup()).getByRole('checkbox', { name });

/** The polite snackbar's text: a confirmation, not an error. */
const confirmation = async () => (await screen.findByRole('dialog', { hidden: true })).textContent;

describe('PersonaPage: not found', () => {
  it.each([
    ['one that doesn’t exist', MISSING_ID],
    ['a malformed id', 'not-an-id'],
  ])('says the Persona is not found for %s, with a link back', async (_, id) => {
    fake.seedPersona({ name: 'Backend engineer' });
    renderPage(id);

    expect(await screen.findByRole('heading', { name: 'Persona not found' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Back to my personas' }).getAttribute('href')).toBe(
      '/personas',
    );
    expect(screen.queryByText('Backend engineer')).toBeNull();
  });
});

describe('PersonaPage: the Persona', () => {
  it('shows its name as the heading, with Rename and Archive and a link back', async () => {
    const persona = fake.seedPersona({ name: 'Backend engineer' });

    renderPage(persona.id);

    expect(await screen.findByRole('heading', { name: 'Backend engineer' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
    expect(screen.queryByText(/This persona is archived/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to my personas' })).toBeDefined();
  });

  it('archives it with a snackbar, says so, and moves focus to Restore', async () => {
    const persona = fake.seedPersona({ name: 'Backend engineer' });

    renderPage(persona.id);
    await userEvent.click(await screen.findByRole('button', { name: 'Archive' }));

    const restore = await screen.findByRole('button', { name: 'Restore' });

    expect(fake.received('personas.update')).toEqual([{ archived: true }]);
    expect(screen.getByText(/This persona is archived/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(restore));
    expect(await confirmation()).toContain('Archived Backend engineer.');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('restores an archived one with a snackbar, and moves focus to Archive', async () => {
    const persona = fake.seedPersona({ name: 'Backend engineer', archivedAt: new Date() });

    renderPage(persona.id);

    expect(await screen.findByText(/This persona is archived/)).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }));

    const archive = await screen.findByRole('button', { name: 'Archive' });

    expect(fake.received('personas.update')).toEqual([{ archived: false }]);
    expect(screen.queryByText(/This persona is archived/)).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(archive));
    expect(await confirmation()).toContain('Restored Backend engineer.');
  });

  it('shows an archive that fails in an error snackbar and leaves it active', async () => {
    const persona = fake.seedPersona({ name: 'Backend engineer' });

    fake.on('personas.update', serverError);
    renderPage(persona.id);
    await userEvent.click(await screen.findByRole('button', { name: 'Archive' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Something went wrong. Please try again.',
    );
    expect(screen.getByRole('button', { name: 'Archive' })).toBeDefined();
  });
});

describe('PersonaPage: renaming', () => {
  const openRename = async () => {
    const button = await screen.findByRole('button', { name: 'Rename' });

    await userEvent.click(button);

    const dialog = await screen.findByRole('alertdialog', { name: /^Rename / });

    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    return { button, dialog, field: within(dialog).getByRole('textbox', { name: 'Name' }) };
  };

  it('saves the new name as the heading, with a snackbar, and returns focus to Rename', async () => {
    const persona = fake.seedPersona({ name: 'Backend engineer' });

    renderPage(persona.id);

    const { button, dialog, field } = await openRename();

    expect(dialog.getAttribute('aria-labelledby')).not.toBeNull();
    expect(field).toHaveProperty('value', 'Backend engineer');
    expect(field.getAttribute('maxLength')).toBe(String(MAX_PERSONA_NAME));

    await userEvent.clear(field);
    await userEvent.type(field, 'Platform engineer');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('heading', { name: 'Platform engineer' })).toBeDefined();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(fake.received('personas.update')).toEqual([{ name: 'Platform engineer' }]);
    expect(await confirmation()).toContain('Renamed to Platform engineer.');
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it('shows a taken name’s message by the field and keeps the dialog open', async () => {
    const persona = fake.seedPersona({ name: 'Backend engineer' });

    fake.on('personas.update', () =>
      Response.json({ _tag: 'PersonaNameTaken', archived: true }, { status: 409 }),
    );
    renderPage(persona.id);

    const { dialog, field } = await openRename();

    await userEvent.clear(field);
    await userEvent.type(field, 'Manager');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(
      await within(dialog).findByText(
        'You have an archived persona with that name. Restore it instead.',
      ),
    ).toBeDefined();
    expect(field).toHaveProperty('value', 'Manager');
    expect(field.getAttribute('aria-invalid')).toBe('true');
  });

  it('says a name of only spaces is blank and sends nothing', async () => {
    const persona = fake.seedPersona({ name: 'Backend engineer' });

    renderPage(persona.id);

    const { dialog, field } = await openRename();

    await userEvent.clear(field);
    await userEvent.type(field, '   ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByText('Enter a persona name.')).toBeDefined();
    expect(fake.received('personas.update')).toEqual([]);
  });

  it('changes nothing on Cancel, and returns focus to Rename', async () => {
    const persona = fake.seedPersona({ name: 'Backend engineer' });

    renderPage(persona.id);

    const { button, dialog, field } = await openRename();

    await userEvent.type(field, ' and more');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(fake.received('personas.update')).toEqual([]);
    await waitFor(() => expect(document.activeElement).toBe(button));
  });
});

describe('PersonaPage: Skills', () => {
  it('lists every active Skill by name, ticked when the Persona has it', async () => {
    const coding = fake.seedSkill({ name: 'Coding' });

    fake.seedSkill({ name: 'Algorithms' });
    fake.seedSkill({ name: 'Leadership', archivedAt: new Date() });
    const persona = fake.seedPersona({ skillIds: [coding.id] });

    renderPage(persona.id);

    await waitFor(() =>
      expect(boxes()).toEqual([
        ['Algorithms', 'false'],
        ['Coding', 'true'],
      ]),
    );
  });

  it('adds a Skill when it’s ticked, and removes it when unticked', async () => {
    fake.seedSkill({ name: 'Coding' });
    const persona = fake.seedPersona();

    renderPage(persona.id);

    await userEvent.click(await screen.findByRole('checkbox', { name: 'Coding' }));

    await waitFor(() => expect(fake.received('personas.addSkill')).toHaveLength(1));
    await waitFor(() => expect(box('Coding').getAttribute('aria-checked')).toBe('true'));

    await userEvent.click(box('Coding'));

    await waitFor(() => expect(fake.received('personas.removeSkill')).toHaveLength(1));
    await waitFor(() => expect(box('Coding').getAttribute('aria-checked')).toBe('false'));
  });

  it('unticks a Skill again when adding it fails, and shows the error', async () => {
    fake.seedSkill({ name: 'Coding' });
    const persona = fake.seedPersona();

    fake.on('personas.addSkill', () => Response.json({ _tag: 'SkillArchived' }, { status: 409 }));
    renderPage(persona.id);

    await userEvent.click(await screen.findByRole('checkbox', { name: 'Coding' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'That skill is archived. Restore it to add it.',
    );
    await waitFor(() => expect(box('Coding').getAttribute('aria-checked')).toBe('false'));
  });

  it('ticks a Skill again when removing it fails, and shows the error', async () => {
    const coding = fake.seedSkill({ name: 'Coding' });
    const persona = fake.seedPersona({ skillIds: [coding.id] });

    fake.on('personas.removeSkill', serverError);
    renderPage(persona.id);

    await userEvent.click(await screen.findByRole('checkbox', { name: 'Coding' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Something went wrong. Please try again.',
    );
    await waitFor(() => expect(box('Coding').getAttribute('aria-checked')).toBe('true'));
  });

  it('lists an archived Skill the Persona has, ticked and marked, until it’s unticked', async () => {
    const leadership = fake.seedSkill({ name: 'Leadership', archivedAt: new Date() });

    fake.seedSkill({ name: 'Coding' });
    const persona = fake.seedPersona({ skillIds: [leadership.id] });

    renderPage(persona.id);

    await waitFor(() =>
      expect(boxes()).toEqual([
        ['Coding', 'false'],
        ['Leadership (archived)', 'true'],
      ]),
    );

    await userEvent.click(box('Leadership (archived)'));

    await waitFor(() => expect(boxes()).toEqual([['Coding', 'false']]));
    expect(fake.received('personas.removeSkill')).toEqual([
      { id: persona.id, skillId: leadership.id },
    ]);
  });

  it('says the library is empty and links to the Skills page', async () => {
    const persona = fake.seedPersona();

    renderPage(persona.id);

    const link = await screen.findByRole('link', { name: 'Add skills on the Skills page' });

    expect(link.getAttribute('href')).toBe('/skills');
    expect(screen.getByText(/Your skill library has no skills to pick from yet/)).toBeDefined();
    expect(screen.queryByRole('group', { name: 'Skills' })).toBeNull();
  });

  it(`disables the unticked Skills, with a note, once the Persona has ${MAX_PERSONA_SKILLS}`, async () => {
    const ticked = Array.from({ length: MAX_PERSONA_SKILLS }, (_, i) =>
      fake.seedSkill({ name: `Skill ${String(i).padStart(2, '0')}` }),
    );

    fake.seedSkill({ name: 'Zebra' });
    const persona = fake.seedPersona({ skillIds: ticked.map((s) => s.id) });

    renderPage(persona.id);

    await waitFor(() => expect(box('Zebra').getAttribute('aria-disabled')).toBe('true'));
    expect(box('Skill 00').getAttribute('aria-disabled')).not.toBe('true');
    expect(screen.getByText(/the most it can have/)).toBeDefined();

    // Unticking one makes room again.
    await userEvent.click(box('Skill 00'));
    await waitFor(() => expect(box('Zebra').getAttribute('aria-disabled')).not.toBe('true'));
    expect(screen.queryByText(/the most it can have/)).toBeNull();
  });

  it('keeps every Skill enabled, without the note, below the limit', async () => {
    const ticked = Array.from({ length: MAX_PERSONA_SKILLS - 1 }, (_, i) =>
      fake.seedSkill({ name: `Skill ${String(i).padStart(2, '0')}` }),
    );

    fake.seedSkill({ name: 'Zebra' });
    const persona = fake.seedPersona({ skillIds: ticked.map((s) => s.id) });

    renderPage(persona.id);

    await waitFor(() => expect(box('Zebra').getAttribute('aria-checked')).toBe('false'));
    expect(box('Zebra').getAttribute('aria-disabled')).not.toBe('true');
    expect(screen.queryByText(/the most it can have/)).toBeNull();
  });
});
