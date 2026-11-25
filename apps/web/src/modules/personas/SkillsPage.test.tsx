import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MAX_SKILL_NAME, MAX_SKILLS } from '@roundtable/contract';
import { describe, expect, it } from 'vitest';
import { SnackbarProvider, createSnackbars } from '../../design-system';
import { serverError, setUpFakeApi } from '../../shared/testing/fake-api';
import { SkillsPage, useSkills } from './index';

// The page calls the real typed client, answered by the in-memory API (ADR-0071). The fake keeps
// Skills in name order but enforces no name rule or limit, so a 409 is an override.
const fake = setUpFakeApi();

const nameTaken = (archived: boolean) => () =>
  Response.json({ _tag: 'SkillNameTaken', archived }, { status: 409 });

/** Every Skill `useSkills` returns, by name: what another module (prep tasks) would see. */
function SkillNames() {
  const skills = useSkills();

  return <output aria-label="Every skill">{skills.data?.map((s) => s.name).join(', ')}</output>;
}

const renderPage = async () => {
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

  render(
    <SnackbarProvider snackbars={appSnackbars}>
      <QueryClientProvider client={queryClient}>
        <SkillsPage />
        <SkillNames />
      </QueryClientProvider>
    </SnackbarProvider>,
  );

  await screen.findByRole('textbox', { name: 'Skill name' });
};

/** The active Skills, as the list reads them, in order. */
const activeNames = () =>
  within(screen.getByRole('list', { name: 'Skills' }))
    .getAllByRole('listitem')
    .map((item) => item.firstChild?.textContent);

const nameField = () => screen.getByRole('textbox', { name: 'Skill name' });

const addSkill = async (name: string) => {
  await userEvent.type(nameField(), name);
  await userEvent.click(screen.getByRole('button', { name: 'Add skill' }));
};

const archivedToggle = () => screen.getByRole('button', { name: /^Archived/ });

describe('SkillsPage: an empty library', () => {
  it('explains what a Skill is for and offers the add form', async () => {
    await renderPage();

    expect(screen.getByRole('heading', { name: 'Skills' })).toBeDefined();
    expect(screen.getByText(/A skill is something you practice for interviews/)).toBeDefined();
    expect(screen.getByRole('form', { name: 'Add a skill' })).toBeDefined();
    expect(screen.queryByRole('list', { name: 'Skills' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Archived/ })).toBeNull();
  });
});

describe('SkillsPage: adding', () => {
  it('adds the Skill in name order and clears the field', async () => {
    fake.seedSkill({ name: 'Behavioral stories' });
    fake.seedSkill({ name: 'System design' });
    await renderPage();

    await addSkill('  Coding  ');

    await waitFor(() =>
      expect(activeNames()).toEqual(['Behavioral stories', 'Coding', 'System design']),
    );
    expect(fake.received('skills.create')).toEqual([{ name: 'Coding' }]);
    expect(nameField()).toHaveProperty('value', '');
    expect(screen.queryByText(/A skill is something you practice/)).toBeNull();
  });

  it.each([
    [false, 'You already have a skill with that name.'],
    [true, 'You have an archived skill with that name. Restore it instead.'],
  ])(
    'shows a taken name’s message by the field and keeps the text (archived: %s)',
    async (archived, message) => {
      fake.on('skills.create', nameTaken(archived));
      await renderPage();

      await addSkill('Coding');

      expect(await screen.findByText(message)).toBeDefined();
      expect(nameField()).toHaveProperty('value', 'Coding');
      expect(nameField().getAttribute('aria-invalid')).toBe('true');
      expect(nameField().getAttribute('aria-describedby')).toContain(screen.getByText(message).id);
    },
  );

  it(`limits the name to ${MAX_SKILL_NAME} characters`, async () => {
    await renderPage();

    expect(nameField().getAttribute('maxLength')).toBe(String(MAX_SKILL_NAME));
  });

  it(`disables the form with a note once the library holds ${MAX_SKILLS} Skills`, async () => {
    for (let i = 0; i < MAX_SKILLS; i += 1) {
      fake.seedSkill({ name: `Skill ${i}`, archivedAt: i % 2 ? new Date() : null });
    }

    await renderPage();

    expect(nameField()).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Add skill' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/Your library is full/)).toBeDefined();
  });

  it('keeps the form enabled, without the note, below the limit', async () => {
    for (let i = 0; i < MAX_SKILLS - 1; i += 1) fake.seedSkill({ name: `Skill ${i}` });

    await renderPage();

    expect(nameField()).toHaveProperty('disabled', false);
    expect(screen.queryByText(/Your library is full/)).toBeNull();
  });
});

describe('SkillsPage: renaming', () => {
  const openRename = async (name: string) => {
    const button = screen.getByRole('button', { name: `Rename ${name}` });

    await userEvent.click(button);

    const dialog = await screen.findByRole('alertdialog', { name: `Rename ${name}` });

    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    return { button, dialog };
  };

  it('saves the new name, re-sorts the list and returns focus to the Rename button', async () => {
    fake.seedSkill({ name: 'Algorithms' });
    fake.seedSkill({ name: 'Behavioral stories' });
    await renderPage();

    const { button, dialog } = await openRename('Algorithms');
    const field = within(dialog).getByRole('textbox', { name: 'Name' });

    expect(field).toHaveProperty('value', 'Algorithms');
    expect(field.getAttribute('maxLength')).toBe(String(MAX_SKILL_NAME));

    await userEvent.clear(field);
    await userEvent.type(field, 'Data structures');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(activeNames()).toEqual(['Behavioral stories', 'Data structures']);
    expect(fake.received('skills.update')).toEqual([{ name: 'Data structures' }]);
    await waitFor(() => expect(document.activeElement).toBe(button));
    expect(button.getAttribute('aria-label')).toBe('Rename Data structures');
  });

  it('shows a taken name’s message by the field and keeps the dialog open with the text', async () => {
    fake.seedSkill({ name: 'Algorithms' });
    fake.on('skills.update', nameTaken(false));
    await renderPage();

    const { dialog } = await openRename('Algorithms');
    const field = within(dialog).getByRole('textbox', { name: 'Name' });

    await userEvent.clear(field);
    await userEvent.type(field, 'Coding');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(
      await within(dialog).findByText('You already have a skill with that name.'),
    ).toBeDefined();
    expect(field).toHaveProperty('value', 'Coding');
    expect(field.getAttribute('aria-invalid')).toBe('true');
  });

  it('changes nothing on Cancel, and returns focus to the Rename button', async () => {
    fake.seedSkill({ name: 'Algorithms' });
    await renderPage();

    const { button, dialog } = await openRename('Algorithms');

    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Name' }), ' and more');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(fake.received('skills.update')).toEqual([]);
    await waitFor(() => expect(document.activeElement).toBe(button));
  });
});

describe('SkillsPage: archiving and restoring', () => {
  it('moves an archived Skill to the collapsed Archived section, with a snackbar', async () => {
    fake.seedSkill({ name: 'Algorithms' });
    fake.seedSkill({ name: 'Coding' });
    await renderPage();

    await userEvent.click(screen.getByRole('button', { name: 'Archive Algorithms' }));

    await waitFor(() => expect(activeNames()).toEqual(['Coding']));
    expect(fake.received('skills.update')).toEqual([{ archived: true }]);

    const toggle = archivedToggle();

    expect(toggle.textContent).toBe('Archived (1)');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('list', { name: 'Archived' })).toBeNull();

    // A confirmation, not an error: a polite dialog, no alert.
    const snackbar = await screen.findByRole('dialog', { hidden: true });

    expect(within(snackbar).getByText('Archived Algorithms.')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();

    await userEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(
      within(screen.getByRole('list', { name: 'Archived' }))
        .getAllByRole('listitem')
        .map((item) => item.firstChild?.textContent),
    ).toEqual(['Algorithms']);
  });

  it('moves a restored Skill back to the list, in name order', async () => {
    fake.seedSkill({ name: 'Algorithms', archivedAt: new Date() });
    fake.seedSkill({ name: 'Behavioral stories', archivedAt: new Date() });
    fake.seedSkill({ name: 'Coding' });
    await renderPage();

    expect(archivedToggle().textContent).toBe('Archived (2)');
    await userEvent.click(archivedToggle());
    await userEvent.click(screen.getByRole('button', { name: 'Restore Algorithms' }));

    await waitFor(() => expect(activeNames()).toEqual(['Algorithms', 'Coding']));
    expect(fake.received('skills.update')).toEqual([{ archived: false }]);
    expect(archivedToggle().textContent).toBe('Archived (1)');
  });

  it('hides the Archived section once nothing is archived', async () => {
    fake.seedSkill({ name: 'Algorithms', archivedAt: new Date() });
    await renderPage();

    await userEvent.click(archivedToggle());
    await userEvent.click(screen.getByRole('button', { name: 'Restore Algorithms' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: /^Archived/ })).toBeNull());
    expect(activeNames()).toEqual(['Algorithms']);
  });

  it('shows a failure in an error snackbar and leaves the Skill where it was', async () => {
    fake.seedSkill({ name: 'Algorithms' });
    fake.on('skills.update', serverError);
    await renderPage();

    await userEvent.click(screen.getByRole('button', { name: 'Archive Algorithms' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Something went wrong. Please try again.',
    );
    expect(activeNames()).toEqual(['Algorithms']);
  });
});

describe('useSkills', () => {
  it('returns every Skill, archived ones included, and follows a rename on the page', async () => {
    fake.seedSkill({ name: 'Algorithms', archivedAt: new Date() });
    fake.seedSkill({ name: 'Coding' });
    await renderPage();

    const every = screen.getByRole('status', { name: 'Every skill' });

    await waitFor(() => expect(every.textContent).toBe('Algorithms, Coding'));

    await userEvent.click(screen.getByRole('button', { name: 'Rename Coding' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Rename Coding' });
    const field = within(dialog).getByRole('textbox', { name: 'Name' });

    await userEvent.clear(field);
    await userEvent.type(field, 'Live coding');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(every.textContent).toBe('Algorithms, Live coding'));
    // One list for both: the page and the hook share the module's query.
    expect(fake.received('skills.list').length).toBeLessThanOrEqual(2);
  });
});
