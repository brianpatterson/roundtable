import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  MAX_PREP_NOTES,
  MAX_PREP_TASK_TITLE,
  MAX_PREP_TASKS,
  type PrepTask,
} from '@roundtable/contract';
import { beforeEach, describe, expect, it } from 'vitest';
import { SnackbarProvider, createSnackbars } from '../../design-system';
import { SkillsPage } from '../personas';
import { serverError, setUpFakeApi } from '../../shared/testing/fake-api';
import { createTestRouter, TestRouterProvider } from '../../shared/testing/router';
import { AgendaPage } from './AgendaPage';
import { ApplicationPage } from './ApplicationPage';

// A Round's Prep on the application's page, through the real typed client and the in-memory API.
const fake = setUpFakeApi();

const ACME_ID = '00000000-0000-4000-8000-000000000001';
const ROUND_ID = '00000000-0000-4000-8000-000000000002';

const SYSTEM_DESIGN = '00000000-0000-4000-8000-0000000000a1';
const ALGORITHMS = '00000000-0000-4000-8000-0000000000a2';
const GRAPHS = '00000000-0000-4000-8000-0000000000a3';

const taskId = (n: number) => `00000000-0000-4000-8000-${String(1000 + n).padStart(12, '0')}`;

/** Task `n`, not done and naming no Skill unless `fields` says. */
const task = (n: number, fields: Partial<PrepTask> = {}): PrepTask => ({
  id: taskId(n),
  title: `Task ${n}`,
  skillId: null,
  completedAt: null,
  ...fields,
});

beforeEach(() => {
  fake.seedApplication({ id: ACME_ID, status: 'interviewing' });
  fake.seedSkill({ id: SYSTEM_DESIGN, name: 'System design' });
  fake.seedSkill({ id: ALGORITHMS, name: 'Algorithms' });
  fake.seedSkill({ id: GRAPHS, name: 'Graphs', archivedAt: new Date('2026-11-01T00:00:00Z') });
});

/** Gives Acme one coding Round with these prep tasks and notes. */
const seedRound = (prepTasks: PrepTask[] = [], prepNotes: string | null = null) =>
  fake.seedRound(ACME_ID, { id: ROUND_ID, interviewType: 'coding', prepTasks, prepNotes });

/** The application's page, with `others` beside it sharing one cache, as in the app. */
const renderPage = async (others: 'agenda' | 'skills' | 'none' = 'none') => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  const router = createTestRouter(
    <>
      <ApplicationPage applicationId={ACME_ID} />
      {others === 'agenda' && <AgendaPage />}
      {others === 'skills' && <SkillsPage />}
    </>,
    '/elsewhere',
  );

  render(
    <SnackbarProvider snackbars={createSnackbars()}>
      <QueryClientProvider client={queryClient}>
        <TestRouterProvider router={router} />
      </QueryClientProvider>
    </SnackbarProvider>,
  );

  await screen.findByRole('region', { name: /^Coding 1 prep/ });
};

const prep = () => screen.getByRole('region', { name: /^Coding 1 prep/ });

/** The tasks the Prep section lists, as their Checkboxes name them, in order. */
const tasksShown = () =>
  within(prep())
    .queryAllByRole('checkbox')
    .map((box) => box.closest('label')?.textContent);

const checkbox = (title: string) => within(prep()).getByRole('checkbox', { name: title });

/** Whether the task's Checkbox is ticked, as a screen reader hears it. */
const ticked = (title: string) => checkbox(title).getAttribute('aria-checked') === 'true';

/** What a text field holds. */
const valueOf = (field: HTMLElement) =>
  field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
    ? field.value
    : undefined;

const taskItem = (title: string) => {
  const item = checkbox(title).closest('li');

  if (!item) throw new Error(`no list item for ${title}`);

  return item;
};

const pickSkill = async (scope: HTMLElement, skill: string) => {
  await userEvent.click(within(scope).getByRole('combobox', { name: 'Skill' }));
  await userEvent.click(await screen.findByRole('option', { name: skill }));
};

/** The options the Skill picker in `scope` lists, in order. */
const skillOptionsShown = async (scope: HTMLElement) => {
  await userEvent.click(within(scope).getByRole('combobox', { name: 'Skill' }));

  const options = (await screen.findAllByRole('option')).map((option) => option.textContent);

  await userEvent.keyboard('{Escape}');

  return options;
};

const addForm = () => screen.getByRole('form', { name: 'Add a prep task to Coding 1' });

const addTask = async (title: string, skill?: string) => {
  await userEvent.type(within(addForm()).getByRole('textbox', { name: 'Task' }), title);

  if (skill) await pickSkill(addForm(), skill);

  await userEvent.click(within(addForm()).getByRole('button', { name: 'Add task' }));
};

const openNotes = async (action: 'Add' | 'Edit') => {
  await userEvent.click(
    within(prep()).getByRole('button', { name: `${action} notes for Coding 1` }),
  );

  return screen.findByRole('alertdialog', { name: 'Prep notes for Coding 1' });
};

describe('a Round’s Prep section', () => {
  it('has a Prep section with no progress while the Round has no tasks', async () => {
    seedRound();
    await renderPage();

    expect(prep().getAttribute('aria-label')).toBe('Coding 1 prep');
    expect(within(prep()).getByRole('heading', { name: 'Prep' })).toBeDefined();
    expect(within(prep()).queryByRole('list', { name: 'Prep tasks' })).toBeNull();
  });

  it('is labeled with how many of its tasks are done', async () => {
    const done = new Date('2026-11-20T00:00:00Z');

    seedRound([
      task(1, { completedAt: done }),
      task(2),
      task(3, { completedAt: done }),
      task(4),
      task(5),
    ]);
    await renderPage();

    expect(prep().getAttribute('aria-label')).toBe('Coding 1 prep, 2 of 5 done');
    expect(within(prep()).getByRole('heading', { name: 'Prep 2 of 5 done' })).toBeDefined();
  });
});

describe('Prep notes', () => {
  it('saves notes and shows them with their line breaks', async () => {
    seedRound();
    await renderPage();
    expect(within(prep()).getByText('No notes yet')).toBeDefined();

    const dialog = await openNotes('Add');

    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Prep notes' }),
      'Read the blog{Enter}Ask about on-call',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(fake.received('applications.setPrepNotes')).toEqual([
      { notes: 'Read the blog\nAsk about on-call' },
    ]);

    const shown = await within(prep()).findByText(/Read the blog/);

    expect(shown.textContent).toBe('Read the blog\nAsk about on-call');
    expect(within(prep()).queryByText('No notes yet')).toBeNull();
  });

  it('removes the notes when they are cleared and saved', async () => {
    seedRound([], 'Old notes');
    await renderPage();
    expect(within(prep()).getByText('Old notes')).toBeDefined();

    const dialog = await openNotes('Edit');
    const field = within(dialog).getByRole('textbox', { name: 'Prep notes' });

    expect(valueOf(field)).toBe('Old notes');
    await userEvent.clear(field);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(prep()).findByText('No notes yet')).toBeDefined();
    expect(fake.received('applications.setPrepNotes')).toEqual([{ notes: null }]);
    expect(within(prep()).queryByText('Old notes')).toBeNull();
  });

  it('refuses notes over the limit without sending them', async () => {
    seedRound();
    await renderPage();

    const dialog = await openNotes('Add');

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Prep notes' }), {
      target: { value: 'x'.repeat(MAX_PREP_NOTES + 1) },
    });

    expect(
      within(dialog).getByText(
        `The notes are ${MAX_PREP_NOTES + 1} characters; they can be at most ${MAX_PREP_NOTES}.`,
      ),
    ).toBeDefined();
    expect(within(dialog).getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(
      true,
    );

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Prep notes' }), {
      target: { value: 'x'.repeat(MAX_PREP_NOTES) },
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(fake.received('applications.setPrepNotes')).toEqual([
        { notes: 'x'.repeat(MAX_PREP_NOTES) },
      ]),
    );
  });

  it('shows why notes couldn’t be saved and keeps what was written', async () => {
    seedRound();
    fake.on('applications.setPrepNotes', serverError);
    await renderPage();

    const dialog = await openNotes('Add');
    const field = within(dialog).getByRole('textbox', { name: 'Prep notes' });

    await userEvent.type(field, 'Practise trees');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(
      await within(dialog).findByText('Something went wrong. Please try again.'),
    ).toBeDefined();
    expect(valueOf(field)).toBe('Practise trees');
  });
});

describe('adding a prep task', () => {
  it('adds a task last and not done, naming the Skill picked', async () => {
    seedRound([task(1)]);
    await renderPage();

    await addTask('Practise consistent hashing', 'System design');

    await waitFor(() => expect(tasksShown()).toEqual(['Task 1', 'Practise consistent hashing']));
    expect(fake.received('applications.addPrepTask')).toEqual([
      { title: 'Practise consistent hashing', skillId: SYSTEM_DESIGN },
    ]);
    expect(ticked('Practise consistent hashing')).toBe(false);
    expect(
      within(taskItem('Practise consistent hashing')).getByText('System design'),
    ).toBeDefined();
    expect(prep().getAttribute('aria-label')).toBe('Coding 1 prep, 0 of 2 done');

    // The form is emptied for the next one.
    expect(valueOf(within(addForm()).getByRole('textbox', { name: 'Task' }))).toBe('');
    expect(within(addForm()).getByRole('combobox', { name: 'Skill' }).textContent).toBe('No skill');
  });

  it('adds a task with no Skill', async () => {
    seedRound();
    await renderPage();

    await addTask('Rest');

    await waitFor(() => expect(tasksShown()).toEqual(['Rest']));
    expect(fake.received('applications.addPrepTask')).toEqual([{ title: 'Rest', skillId: null }]);
  });

  it('offers only active Skills in name order, after "No skill", and links to the Skills page', async () => {
    seedRound();
    await renderPage();
    await waitFor(() =>
      expect(within(addForm()).getByRole('combobox', { name: 'Skill' }).textContent).toBe(
        'No skill',
      ),
    );

    expect(await skillOptionsShown(addForm())).toEqual(['No skill', 'Algorithms', 'System design']);
    expect(
      within(addForm()).getByRole('link', { name: 'manage your skills' }).getAttribute('href'),
    ).toBe('/skills');
  });

  it('refuses a blank title without sending it', async () => {
    seedRound();
    await renderPage();

    await userEvent.type(within(addForm()).getByRole('textbox', { name: 'Task' }), '   ');
    await userEvent.click(within(addForm()).getByRole('button', { name: 'Add task' }));

    expect(within(addForm()).getByText('Enter a task.')).toBeDefined();
    expect(fake.received('applications.addPrepTask')).toEqual([]);
  });

  it('refuses a title over the limit without sending it', async () => {
    seedRound();
    await renderPage();

    const field = within(addForm()).getByRole('textbox', { name: 'Task' });

    fireEvent.change(field, { target: { value: 'x'.repeat(MAX_PREP_TASK_TITLE + 1) } });
    await userEvent.click(within(addForm()).getByRole('button', { name: 'Add task' }));

    expect(
      within(addForm()).getByText(`A task can be at most ${MAX_PREP_TASK_TITLE} characters.`),
    ).toBeDefined();
    expect(fake.received('applications.addPrepTask')).toEqual([]);

    fireEvent.change(field, { target: { value: 'x'.repeat(MAX_PREP_TASK_TITLE) } });
    await userEvent.click(within(addForm()).getByRole('button', { name: 'Add task' }));

    await waitFor(() =>
      expect(fake.received('applications.addPrepTask')).toEqual([
        { title: 'x'.repeat(MAX_PREP_TASK_TITLE), skillId: null },
      ]),
    );
  });

  it('disables the form with a note once the Round has the most tasks it can', async () => {
    seedRound(Array.from({ length: MAX_PREP_TASKS }, (_, i) => task(i + 1)));
    await renderPage();

    const form = addForm();

    expect(within(form).getByRole('textbox', { name: 'Task' }).hasAttribute('disabled')).toBe(true);
    expect(within(form).getByRole('button', { name: 'Add task' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(
      within(form).getByText(
        `This round has ${MAX_PREP_TASKS} prep tasks, the most it can have. Delete one to add another.`,
      ),
    ).toBeDefined();
  });

  it('shows why a task couldn’t be added and keeps what was entered', async () => {
    seedRound();
    fake.on('applications.addPrepTask', serverError);
    await renderPage();

    await addTask('Mock interview', 'Algorithms');

    expect(
      await within(addForm()).findByText('Something went wrong. Please try again.'),
    ).toBeDefined();
    expect(valueOf(within(addForm()).getByRole('textbox', { name: 'Task' }))).toBe(
      'Mock interview',
    );
    expect(within(addForm()).getByRole('combobox', { name: 'Skill' }).textContent).toBe(
      'Algorithms',
    );
  });
});

describe('a prep task', () => {
  it('is marked done when ticked, and not done when unticked, updating the progress', async () => {
    seedRound([task(1), task(2)]);
    await renderPage();

    await userEvent.click(checkbox('Task 1'));

    await waitFor(() =>
      expect(prep().getAttribute('aria-label')).toBe('Coding 1 prep, 1 of 2 done'),
    );
    expect(ticked('Task 1')).toBe(true);
    expect(fake.rounds(ACME_ID)[0]?.prepTasks[0]?.completedAt).not.toBeNull();

    await userEvent.click(checkbox('Task 1'));

    await waitFor(() =>
      expect(prep().getAttribute('aria-label')).toBe('Coding 1 prep, 0 of 2 done'),
    );
    expect(ticked('Task 1')).toBe(false);
    expect(fake.received('applications.updatePrepTask')).toEqual([{ done: true }, { done: false }]);
  });

  it('shows why a tick couldn’t be saved, and leaves the task as it was', async () => {
    seedRound([task(1)]);
    fake.on('applications.updatePrepTask', serverError);
    await renderPage();

    await userEvent.click(checkbox('Task 1'));

    expect(
      await within(taskItem('Task 1')).findByText('Something went wrong. Please try again.'),
    ).toBeDefined();
    expect(ticked('Task 1')).toBe(false);
  });

  it('shows the name of the Skill it names, marking an archived one', async () => {
    seedRound([task(1, { skillId: ALGORITHMS }), task(2, { skillId: GRAPHS })]);
    await renderPage();

    expect(await within(taskItem('Task 1')).findByText('Algorithms')).toBeDefined();
    expect(within(taskItem('Task 2')).getByText('Graphs (archived)')).toBeDefined();
  });

  it('shows a Skill’s new name once it’s renamed on the Skills page', async () => {
    seedRound([task(1, { skillId: ALGORITHMS })]);
    await renderPage('skills');
    expect(await within(taskItem('Task 1')).findByText('Algorithms')).toBeDefined();

    await userEvent.click(screen.getByRole('button', { name: 'Rename Algorithms' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Rename Algorithms' });
    const field = within(dialog).getByRole('textbox', { name: 'Name' });

    await userEvent.clear(field);
    await userEvent.type(field, 'Data structures');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(taskItem('Task 1')).findByText('Data structures')).toBeDefined();
  });

  it('is edited in a dialog, which returns focus to its Edit button', async () => {
    seedRound([task(1, { skillId: GRAPHS })]);
    await renderPage();

    const edit = within(taskItem('Task 1')).getByRole('button', { name: 'Edit task Task 1' });

    await userEvent.click(edit);

    const dialog = await screen.findByRole('alertdialog', { name: 'Edit prep task' });

    // The archived Skill already on the task stays selectable; other archived ones don't show.
    expect(within(dialog).getByRole('combobox', { name: 'Skill' }).textContent).toBe(
      'Graphs (archived)',
    );
    expect(await skillOptionsShown(dialog)).toEqual([
      'No skill',
      'Algorithms',
      'Graphs (archived)',
      'System design',
    ]);

    const title = within(dialog).getByRole('textbox', { name: 'Title' });

    await userEvent.clear(title);
    await userEvent.type(title, 'Review graph search');
    await pickSkill(dialog, 'Algorithms');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(fake.received('applications.updatePrepTask')).toEqual([
      { title: 'Review graph search', skillId: ALGORITHMS },
    ]);
    expect(
      await within(prep()).findByRole('checkbox', { name: 'Review graph search' }),
    ).toBeDefined();
    expect(within(taskItem('Review graph search')).getByText('Algorithms')).toBeDefined();
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toBe(
        'Edit task Review graph search',
      ),
    );
  });

  it('keeps the dialog open with what was entered when an edit fails', async () => {
    seedRound([task(1)]);
    fake.on('applications.updatePrepTask', serverError);
    await renderPage();

    await userEvent.click(
      within(taskItem('Task 1')).getByRole('button', { name: 'Edit task Task 1' }),
    );

    const dialog = await screen.findByRole('alertdialog', { name: 'Edit prep task' });
    const title = within(dialog).getByRole('textbox', { name: 'Title' });

    await userEvent.type(title, ' again');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(
      await within(dialog).findByText('Something went wrong. Please try again.'),
    ).toBeDefined();
    expect(valueOf(title)).toBe('Task 1 again');
  });

  it('refuses a blank title in the dialog without sending it', async () => {
    seedRound([task(1)]);
    await renderPage();

    await userEvent.click(
      within(taskItem('Task 1')).getByRole('button', { name: 'Edit task Task 1' }),
    );

    const dialog = await screen.findByRole('alertdialog', { name: 'Edit prep task' });

    await userEvent.clear(within(dialog).getByRole('textbox', { name: 'Title' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(within(dialog).getByText('Enter a task.')).toBeDefined();
    expect(fake.received('applications.updatePrepTask')).toEqual([]);
  });

  it('refuses a title over the limit in the dialog without sending it', async () => {
    seedRound([task(1)]);
    await renderPage();

    await userEvent.click(
      within(taskItem('Task 1')).getByRole('button', { name: 'Edit task Task 1' }),
    );

    const dialog = await screen.findByRole('alertdialog', { name: 'Edit prep task' });

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Title' }), {
      target: { value: 'x'.repeat(MAX_PREP_TASK_TITLE + 1) },
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(
      within(dialog).getByText(`A task can be at most ${MAX_PREP_TASK_TITLE} characters.`),
    ).toBeDefined();
    expect(fake.received('applications.updatePrepTask')).toEqual([]);
  });

  it('is removed when deleted', async () => {
    seedRound([task(1), task(2)]);
    await renderPage();

    await userEvent.click(
      within(taskItem('Task 1')).getByRole('button', { name: 'Delete task Task 1' }),
    );

    await waitFor(() => expect(tasksShown()).toEqual(['Task 2']));
    expect(fake.rounds(ACME_ID)[0]?.prepTasks.map((t) => t.id)).toEqual([taskId(2)]);
  });

  it('shows why it couldn’t be deleted, and stays', async () => {
    seedRound([task(1)]);
    fake.on('applications.deletePrepTask', serverError);
    await renderPage();

    await userEvent.click(
      within(taskItem('Task 1')).getByRole('button', { name: 'Delete task Task 1' }),
    );

    expect(
      await within(taskItem('Task 1')).findByText('Something went wrong. Please try again.'),
    ).toBeDefined();
    expect(tasksShown()).toEqual(['Task 1']);
  });
});

describe('the Agenda, when Prep changes', () => {
  const agendaRequests = () => fake.calls().filter((c) => c.endpoint === 'agenda.list').length;

  it('is asked again after each change to prep', async () => {
    seedRound([task(1)]);
    await renderPage('agenda');
    await waitFor(() => expect(agendaRequests()).toBe(1));

    await userEvent.click(checkbox('Task 1'));
    await waitFor(() => expect(agendaRequests()).toBe(2));

    await addTask('Another');
    await waitFor(() => expect(agendaRequests()).toBe(3));

    await userEvent.click(
      within(taskItem('Another')).getByRole('button', { name: 'Delete task Another' }),
    );
    await waitFor(() => expect(agendaRequests()).toBe(4));

    const dialog = await openNotes('Add');

    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Prep notes' }), 'Notes');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(agendaRequests()).toBe(5));
  });

  it('shows the new Prep progress after a task is ticked', async () => {
    seedRound([task(1), task(2)]);
    await renderPage('agenda');

    const agenda = screen.getByRole('region', { name: 'Agenda' });

    expect(await within(agenda).findByText('Prep 0 of 2 done')).toBeDefined();

    await userEvent.click(checkbox('Task 1'));
    expect(await within(agenda).findByText('Prep 1 of 2 done')).toBeDefined();

    await userEvent.click(checkbox('Task 2'));
    expect(await within(agenda).findByText('Prep done')).toBeDefined();
  });
});
