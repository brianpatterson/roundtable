import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InterviewType, Round } from '@roundtable/contract';
import { beforeEach, describe, expect, it } from 'vitest';
import { SnackbarProvider } from '../../design-system';
import { serverError, setUpFakeApi } from '../../shared/testing/fake-api';
import { createTestRouter, TestRouterProvider } from '../../shared/testing/router';
import { AgendaPage } from './AgendaPage';
import { ApplicationPage } from './ApplicationPage';

// The page calls the real typed client, answered by the in-memory API, which keeps one applied
// application and its Rounds. It infers nothing: a test that needs an inferred Outcome, or the
// move to interviewing, makes it in an override, as the API would.
const fake = setUpFakeApi();

const ACME_ID = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  fake.seedApplication({ id: ACME_ID, status: 'applied' });
});

const roundId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Round `n` of `interviewType`, with the fields a test cares about; a start as ISO 8601. */
const round = (
  n: number,
  interviewType: InterviewType,
  { startsAt, ...fields }: Partial<Omit<Round, 'startsAt'>> & { startsAt?: string } = {},
): Partial<Round> => ({
  ...fields,
  id: roundId(n),
  interviewType,
  startsAt: startsAt === undefined ? null : new Date(startsAt),
});

/** Gives Acme these Rounds, in the order they were added. */
const seed = (...rounds: Partial<Round>[]) => {
  for (const fields of rounds) fake.seedRound(ACME_ID, fields);
};

/** Acme's Rounds, as the fake holds them. */
const stored = () => fake.rounds(ACME_ID);

/** The Rounds the page added, without the time zone it sent with each. */
const added = () =>
  fake.received('applications.createRound').map((payload) => {
    const { timeZone: _, ...body } = payload;

    return body;
  });

const scheduled = () => fake.received('applications.scheduleRound');

const ratings = () => fake.received('applications.rateRound');

const outcomes = () => fake.received('applications.setRoundOutcome');

const renderPage = async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createTestRouter(<ApplicationPage applicationId={ACME_ID} />, '/elsewhere');

  // The shell mounts the snackbars around every page; the page's Persona picker confirms in one.
  render(
    <SnackbarProvider>
      <QueryClientProvider client={queryClient}>
        <TestRouterProvider router={router} />
      </QueryClientProvider>
    </SnackbarProvider>,
  );

  await screen.findByRole('heading', { name: 'Rounds' });
};

/** Formatted dates' narrow spaces become plain. */
const plain = (text: string | null | undefined) => text?.replace(/\s+/g, ' ');

/** The Rounds' items in the list, in order: only the Rounds, though each holds a list of its Tags. */
const items = async () => {
  const list = await screen.findByRole('list', { name: 'Rounds' });

  return within(list)
    .getAllByRole('listitem')
    .filter((item) => item.parentElement === list);
};

/** A listed Round's name, as its buttons carry it: `Coding 2`. */
const nameOf = (item: HTMLElement) =>
  plain(
    within(item)
      .getByRole('button', { name: /^Delete / })
      .getAttribute('aria-label'),
  )?.slice('Delete '.length) ?? '';

/** The Rounds as the page names them (their type and which of that type), in order. */
const listed = async () => (await items()).map(nameOf);

/** The name a listed Round shows. */
const nameShown = (item: HTMLElement) => within(item).getByText(nameOf(item), { selector: 'span' });

/** Where a Round's Tags are shown and added, e.g. `tagsGroup('Coding 1')`. */
const tagsGroup = (name: string) => screen.getByRole('group', { name: `${name} tags` });

/** The Tags a Round shows, in order. */
const tagsShown = (name: string) =>
  within(tagsGroup(name))
    .queryAllByRole('listitem')
    .map((item) => item.textContent);

const addTag = async (name: string, tag: string) => {
  const group = tagsGroup(name);

  await userEvent.type(within(group).getByRole('textbox', { name: 'Tag' }), tag);
  await userEvent.click(within(group).getByRole('button', { name: 'Add tag' }));
};

/** The status the page's fields show. */
const statusShown = () => {
  const index = screen.getAllByRole('term').findIndex((term) => term.textContent === 'Status');

  return screen.getAllByRole('definition')[index]?.textContent;
};

const addRound = async (type: string) => {
  await userEvent.click(screen.getByRole('combobox', { name: 'Interview type' }));
  await userEvent.click(await screen.findByRole('option', { name: type }));
  await userEvent.click(screen.getByRole('button', { name: 'Add round' }));
};

/** When each listed Round is, as the list shows it under its name. */
const whenListed = async () =>
  (await items()).map((item) => plain(nameShown(item).nextSibling?.textContent));

/** Picks how a Round is scheduled, in the add form or the edit dialog. */
const pickWhen = async (scope: HTMLElement, label: string) => {
  await userEvent.click(within(scope).getByRole('combobox', { name: 'When' }));
  await userEvent.click(await screen.findByRole('option', { name: label }));
};

/** Sets a date or time field the way the browser's picker does: the whole value at once. */
const fill = (scope: HTMLElement, label: string, value: string) =>
  fireEvent.change(within(scope).getByLabelText(label), { target: { value } });

const addForm = () => screen.getByRole('form', { name: 'Add a round' });

const openScheduleDialog = async (name: string) => {
  await userEvent.click(await screen.findByRole('button', { name: `Edit schedule of ${name}` }));
  const dialog = await screen.findByRole('alertdialog', { name: `Schedule ${name}` });

  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

  return dialog;
};

/**
 * An override that holds a request until `release` is called, then answers with `answer`, or
 * from memory without one.
 */
const hold = (answer?: () => Response) => {
  let release = () => {};

  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const override = async () => {
    await held;

    return answer?.();
  };

  return { override, release };
};

/** The page's Rounds section. */
const roundsRegion = () => screen.getByRole('region', { name: 'Rounds' });

const openDeleteDialog = async (name: string) => {
  await userEvent.click(await screen.findByRole('button', { name: `Delete ${name}` }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Delete round?' });

  // Base UI moves focus in on the next frame.
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

  return dialog;
};

describe('Rounds on an application’s page', () => {
  it('says there are none yet', async () => {
    await renderPage();

    expect(await screen.findByText('No rounds yet.')).toBeDefined();
    expect(screen.queryByRole('list', { name: 'Rounds' })).toBeNull();
  });

  it('names each Round by its type and which of that type it is, in list order', async () => {
    seed(
      round(1, 'coding'),
      round(2, 'take_home'),
      round(3, 'coding'),
      round(4, 'behavioral'),
      round(5, 'coding'),
    );
    await renderPage();

    expect(await listed()).toEqual([
      'Coding 1',
      'Take-home 1',
      'Coding 2',
      'Behavioral 1',
      'Coding 3',
    ]);
    expect((await items()).map((item) => nameShown(item).textContent)).toEqual(await listed());
  });

  it('offers every Interview type, in the fixed order', async () => {
    await renderPage();
    await userEvent.click(screen.getByRole('combobox', { name: 'Interview type' }));

    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);

    expect(options).toEqual([
      'Recruiter screen',
      'Hiring manager',
      'Coding',
      'System design',
      'Behavioral',
      'Take-home',
      'Presentation',
      'Other',
    ]);
  });

  it('adds a Round of the picked type to the list', async () => {
    await renderPage();
    await addRound('Coding');

    await waitFor(async () => expect(await listed()).toEqual(['Coding 1']));
    expect(added()).toEqual([{ interviewType: 'coding' }]);
    expect(screen.queryByText('No rounds yet.')).toBeNull();
  });

  it('adds a Recruiter screen when the type isn’t changed', async () => {
    await renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Add round' }));

    await waitFor(async () => expect(await listed()).toEqual(['Recruiter screen 1']));
  });

  it('shows the application as interviewing once its first Round is added', async () => {
    // The API moves an applied application to interviewing with its first Round.
    fake.on('applications.createRound', () => {
      fake.changeApplication(ACME_ID, { status: 'interviewing' });

      return undefined;
    });
    await renderPage();
    expect(statusShown()).toBe('Applied');

    await addRound('Behavioral');

    await waitFor(() => expect(statusShown()).toBe('Interviewing'));
  });

  it('shows why a Round couldn’t be added', async () => {
    fake.on('applications.createRound', serverError);
    await renderPage();
    await addRound('Coding');

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Something went wrong. Please try again.',
    );
    expect(screen.getByText('No rounds yet.')).toBeDefined();
  });

  it('deletes a Round after confirming, naming it in the dialog', async () => {
    seed(round(1, 'coding'), round(2, 'behavioral'));
    await renderPage();

    const dialog = await openDeleteDialog('Behavioral 1');

    expect(dialog.textContent).toContain('Behavioral 1 will be deleted.');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await listed()).toEqual(['Coding 1']);
    expect(stored().map((r) => r.id)).toEqual([roundId(1)]);
  });

  it('keeps the Round when the user cancels', async () => {
    seed(round(1, 'coding'));
    await renderPage();

    const dialog = await openDeleteDialog('Coding 1');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(stored()).toHaveLength(1);
    expect(await listed()).toEqual(['Coding 1']);
  });

  it('closes the dialog when the Round was already deleted elsewhere', async () => {
    seed(round(1, 'coding'));
    await renderPage();

    const dialog = await openDeleteDialog('Coding 1');

    fake.removeRound(roundId(1));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await screen.findByText('No rounds yet.')).toBeDefined();
  });

  it('keeps the dialog open with the error inside when the delete fails', async () => {
    seed(round(1, 'coding'));
    await renderPage();

    const dialog = await openDeleteDialog('Coding 1');

    fake.on('applications.deleteRound', serverError);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Something went wrong. Please try again.',
    );
    expect(screen.getByRole('alertdialog')).toBe(dialog);
  });

  it('closes the delete dialog with Escape, keeping the Round', async () => {
    seed(round(1, 'coding'));
    await renderPage();
    await openDeleteDialog('Coding 1');

    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(stored()).toHaveLength(1);
    expect(await listed()).toEqual(['Coding 1']);
  });

  it('stays open on Escape while deleting, so a failure still shows', async () => {
    seed(round(1, 'coding'));
    await renderPage();

    const dialog = await openDeleteDialog('Coding 1');
    const { override, release } = hold(serverError);

    fake.on('applications.deleteRound', override);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await userEvent.keyboard('{Escape}');
    release();

    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Something went wrong. Please try again.',
    );
    expect(screen.getByRole('alertdialog')).toBe(dialog);
  });

  it('opens the delete dialog again without the last failure', async () => {
    seed(round(1, 'coding'));
    await renderPage();

    let dialog = await openDeleteDialog('Coding 1');

    fake.on('applications.deleteRound', serverError);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await within(dialog).findByRole('alert');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

    dialog = await openDeleteDialog('Coding 1');

    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('shows the Rounds are loading until the server answers', async () => {
    const { override, release } = hold();

    fake.on('applications.listRounds', override);
    await renderPage();

    expect(within(roundsRegion()).getByText('Loading rounds…')).toBeDefined();

    release();

    expect(await within(roundsRegion()).findByText('No rounds yet.')).toBeDefined();
    expect(within(roundsRegion()).queryByText('Loading rounds…')).toBeNull();
  });

  it('says why the Rounds couldn’t be loaded', async () => {
    fake.on('applications.listRounds', serverError);
    await renderPage();

    expect((await within(roundsRegion()).findByRole('alert')).textContent).toBe(
      'Something went wrong. Please try again.',
    );
    expect(within(roundsRegion()).queryByText('Loading rounds…')).toBeNull();
  });

  it('adds a Round without the browser submitting the form and leaving the page', async () => {
    await renderPage();

    // `fireEvent` returns false when the page cancelled the browser's own handling of the event.
    expect(fireEvent.submit(addForm())).toBe(false);
    await waitFor(async () => expect(await listed()).toEqual(['Recruiter screen 1']));
  });
});

const tagField = (name: string) =>
  within(tagsGroup(name)).getByRole<HTMLInputElement>('textbox', { name: 'Tag' });

describe('Tags on a Round', () => {
  it('shows a Round’s Tags in order', async () => {
    seed(round(1, 'coding', { tags: ['React', 'SQL'] }), round(2, 'behavioral'));
    await renderPage();
    await listed();

    expect(tagsShown('Coding 1')).toEqual(['React', 'SQL']);
    expect(tagsShown('Behavioral 1')).toEqual([]);
  });

  it('adds a Tag to that Round only, and empties the field', async () => {
    seed(round(1, 'coding', { tags: ['React'] }), round(2, 'behavioral'));
    await renderPage();
    await listed();
    await addTag('Coding 1', 'live debugging');

    await waitFor(() => expect(tagsShown('Coding 1')).toEqual(['React', 'live debugging']));
    expect(tagsShown('Behavioral 1')).toEqual([]);
    expect(tagField('Coding 1').value).toBe('');
  });

  it('adds a Tag with Enter', async () => {
    seed(round(1, 'coding'));
    await renderPage();
    await listed();
    await userEvent.type(tagField('Coding 1'), 'SQL[Enter]');

    await waitFor(() => expect(tagsShown('Coding 1')).toEqual(['SQL']));
  });

  it('removes a Tag', async () => {
    seed(round(1, 'coding', { tags: ['React', 'SQL', 'Go'] }));
    await renderPage();
    await listed();
    await userEvent.click(
      within(tagsGroup('Coding 1')).getByRole('button', { name: 'Remove SQL' }),
    );

    await waitFor(() => expect(tagsShown('Coding 1')).toEqual(['React', 'Go']));
    expect(stored()[0]?.tags).toEqual(['React', 'Go']);
  });

  it('keeps one Tag when the same one is added in another case or with spaces', async () => {
    seed(round(1, 'coding', { tags: ['SQL'] }));
    await renderPage();
    await listed();
    await addTag('Coding 1', '  sql ');

    await waitFor(() => expect(tagField('Coding 1').value).toBe(''));
    expect(tagsShown('Coding 1')).toEqual(['SQL']);
    expect(stored()[0]?.tags).toEqual(['SQL']);
  });

  it('says why a blank Tag isn’t added', async () => {
    seed(round(1, 'coding'));
    await renderPage();
    await listed();
    await addTag('Coding 1', '   ');

    expect(await within(tagsGroup('Coding 1')).findByText('Enter a tag.')).toBeDefined();
    expect(fake.received('applications.addTag')).toEqual([]);
    expect(tagField('Coding 1').getAttribute('aria-invalid')).toBe('true');
    expect(tagsShown('Coding 1')).toEqual([]);
  });

  it('says why a Tag over 40 characters isn’t added', async () => {
    seed(round(1, 'coding'));
    await renderPage();
    await listed();
    await addTag('Coding 1', `  ${'x'.repeat(40)}  `);
    await waitFor(() => expect(tagsShown('Coding 1')).toEqual(['x'.repeat(40)]));

    await addTag('Coding 1', 'y'.repeat(41));

    expect(
      await within(tagsGroup('Coding 1')).findByText('A tag can be at most 40 characters.'),
    ).toBeDefined();
    expect(tagsShown('Coding 1')).toEqual(['x'.repeat(40)]);
  });

  it('says why an eleventh Tag isn’t added, keeping what was typed', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => `tag ${i + 1}`);

    seed(round(1, 'coding', { tags: ten }));
    await renderPage();
    await listed();
    await addTag('Coding 1', 'one more');

    expect(
      await within(tagsGroup('Coding 1')).findByText('A round can have at most 10 tags.'),
    ).toBeDefined();
    expect(tagField('Coding 1').value).toBe('one more');
    expect(tagsShown('Coding 1')).toEqual(ten);
  });

  it('clears the message once the user types again', async () => {
    seed(round(1, 'coding'));
    await renderPage();
    await listed();
    await addTag('Coding 1', ' ');
    await within(tagsGroup('Coding 1')).findByText('Enter a tag.');
    await userEvent.type(tagField('Coding 1'), 'R');

    expect(within(tagsGroup('Coding 1')).queryByText('Enter a tag.')).toBeNull();
  });

  it('says why a Tag couldn’t be removed', async () => {
    seed(round(1, 'coding', { tags: ['React'] }));
    await renderPage();
    await listed();

    fake.on('applications.removeTag', serverError);
    await userEvent.click(
      within(tagsGroup('Coding 1')).getByRole('button', { name: 'Remove React' }),
    );

    expect((await within(tagsGroup('Coding 1')).findByRole('alert')).textContent).toBe(
      'Something went wrong. Please try again.',
    );
    expect(tagsShown('Coding 1')).toEqual(['React']);
  });

  it('clears a failed removal’s message once the user types and adds a Tag', async () => {
    seed(round(1, 'coding', { tags: ['React'] }));
    await renderPage();
    await listed();

    fake.on('applications.removeTag', serverError);
    await userEvent.click(
      within(tagsGroup('Coding 1')).getByRole('button', { name: 'Remove React' }),
    );
    await within(tagsGroup('Coding 1')).findByRole('alert');

    fake.off('applications.removeTag');
    await addTag('Coding 1', 'SQL');

    await waitFor(() => expect(tagsShown('Coding 1')).toEqual(['React', 'SQL']));
    expect(within(tagsGroup('Coding 1')).queryByRole('alert')).toBeNull();
  });
});

// The tests run in America/Los_Angeles (vite.config.ts): UTC−8 on these November dates.
describe('a Round’s schedule', () => {
  it('adds a Round at a local time with a duration, and shows its start and end', async () => {
    await renderPage();
    await pickWhen(addForm(), 'At a time');
    fill(addForm(), 'Starts', '2026-11-25T10:00');
    fill(addForm(), 'Duration (minutes)', '90');
    await userEvent.click(screen.getByRole('button', { name: 'Add round' }));

    await waitFor(async () =>
      expect(await whenListed()).toEqual(['Nov 25, 2026, 10:00 – 11:30 AM']),
    );
    expect(added()).toEqual([
      {
        interviewType: 'recruiter_screen',
        startsAt: new Date('2026-11-25T18:00:00.000Z'),
        durationMinutes: 90,
      },
    ]);
  });

  it('adds a Round with a start and no duration, showing just its start', async () => {
    await renderPage();
    await pickWhen(addForm(), 'At a time');
    fill(addForm(), 'Starts', '2026-11-25T16:30');
    await userEvent.click(screen.getByRole('button', { name: 'Add round' }));

    await waitFor(async () => expect(await whenListed()).toEqual(['Nov 25, 2026, 4:30 PM']));
    expect(added()).toEqual([
      { interviewType: 'recruiter_screen', startsAt: new Date('2026-11-26T00:30:00.000Z') },
    ]);
  });

  it('shows a start the server sends in the user’s time zone, a day earlier than UTC', async () => {
    seed(round(1, 'coding', { startsAt: '2026-11-26T01:30:00.000Z', durationMinutes: 45 }));
    await renderPage();

    expect(await whenListed()).toEqual(['Nov 25, 2026, 5:30 – 6:15 PM']);
  });

  it('adds a take-home due on a date, and shows it as due that day', async () => {
    await renderPage();
    await userEvent.click(screen.getByRole('combobox', { name: 'Interview type' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Take-home' }));
    await pickWhen(addForm(), 'Due by a date');
    fill(addForm(), 'Due date', '2026-12-01');
    await userEvent.click(screen.getByRole('button', { name: 'Add round' }));

    await waitFor(async () => expect(await whenListed()).toEqual(['Due Dec 1, 2026']));
    expect(added()).toEqual([{ interviewType: 'take_home', dueOn: '2026-12-01' }]);
  });

  it('adds a Round with neither as not scheduled yet', async () => {
    await renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Add round' }));

    await waitFor(async () => expect(await whenListed()).toEqual(['Not scheduled yet']));
    expect(added()).toEqual([{ interviewType: 'recruiter_screen' }]);
  });

  it('sends only the picked kind’s fields after switching kinds', async () => {
    await renderPage();
    await pickWhen(addForm(), 'At a time');
    fill(addForm(), 'Starts', '2026-11-25T10:00');
    await pickWhen(addForm(), 'Due by a date');
    fill(addForm(), 'Due date', '2026-12-01');
    await userEvent.click(screen.getByRole('button', { name: 'Add round' }));

    await waitFor(() =>
      expect(added()).toEqual([{ interviewType: 'recruiter_screen', dueOn: '2026-12-01' }]),
    );
  });

  it('clears the schedule fields once a Round is added', async () => {
    await renderPage();
    await pickWhen(addForm(), 'Due by a date');
    fill(addForm(), 'Due date', '2026-12-01');
    await userEvent.click(screen.getByRole('button', { name: 'Add round' }));

    await waitFor(async () => expect(await whenListed()).toEqual(['Due Dec 1, 2026']));
    expect(within(addForm()).getByRole('combobox', { name: 'When' }).textContent).toBe(
      'Not scheduled yet',
    );
    expect(within(addForm()).queryByLabelText('Due date')).toBeNull();
  });

  it.each([
    ['a start time', 'At a time', [], 'Enter the date and time it starts.'],
    ['a due date', 'Due by a date', [], 'Enter the date it’s due.'],
    [
      'a duration under 5 minutes',
      'At a time',
      [
        ['Starts', '2026-11-25T10:00'],
        ['Duration (minutes)', '4'],
      ],
      'The duration is a whole number of minutes, from 5 to 480.',
    ],
    [
      'a duration over 480 minutes',
      'At a time',
      [
        ['Starts', '2026-11-25T10:00'],
        ['Duration (minutes)', '481'],
      ],
      'The duration is a whole number of minutes, from 5 to 480.',
    ],
    [
      'a fractional duration',
      'At a time',
      [
        ['Starts', '2026-11-25T10:00'],
        ['Duration (minutes)', '30.5'],
      ],
      'The duration is a whole number of minutes, from 5 to 480.',
    ],
  ] satisfies [string, string, [string, string][], string][])(
    'says what’s missing without sending anything: %s',
    async (_name, kind, fields, message) => {
      await renderPage();
      await pickWhen(addForm(), kind);

      for (const [label, value] of fields) fill(addForm(), label, value);
      await userEvent.click(screen.getByRole('button', { name: 'Add round' }));

      expect((await screen.findByRole('alert')).textContent).toBe(message);
      expect(added()).toEqual([]);
    },
  );

  it('accepts the shortest and longest durations', async () => {
    await renderPage();

    for (const [i, minutes] of ['5', '480'].entries()) {
      await pickWhen(addForm(), 'At a time');
      fill(addForm(), 'Starts', '2026-11-25T10:00');
      fill(addForm(), 'Duration (minutes)', minutes);
      await userEvent.click(screen.getByRole('button', { name: 'Add round' }));
      await waitFor(() => expect(added()).toHaveLength(i + 1));
    }

    const startsAt = new Date('2026-11-25T18:00:00.000Z');

    expect(added()).toEqual([
      { interviewType: 'recruiter_screen', startsAt, durationMinutes: 5 },
      { interviewType: 'recruiter_screen', startsAt, durationMinutes: 480 },
    ]);
  });

  it('opens the editor with the Round’s schedule filled in', async () => {
    seed(round(1, 'coding', { startsAt: '2026-11-26T01:30:00.000Z', durationMinutes: 45 }));
    await renderPage();

    const dialog = await openScheduleDialog('Coding 1');

    expect(within(dialog).getByRole('combobox', { name: 'When' }).textContent).toBe('At a time');
    expect(within(dialog).getByLabelText<HTMLInputElement>('Starts').value).toBe(
      '2026-11-25T17:30',
    );
    expect(within(dialog).getByLabelText<HTMLInputElement>('Duration (minutes)').value).toBe('45');
  });

  it('opens the editor for a take-home with its due date', async () => {
    seed(round(1, 'take_home', { dueOn: '2026-12-01' }));
    await renderPage();

    const dialog = await openScheduleDialog('Take-home 1');

    expect(within(dialog).getByRole('combobox', { name: 'When' }).textContent).toBe(
      'Due by a date',
    );
    expect(within(dialog).getByLabelText<HTMLInputElement>('Due date').value).toBe('2026-12-01');
  });

  it('sets, changes and clears a Round’s schedule', async () => {
    seed(round(1, 'coding'));
    await renderPage();

    let dialog = await openScheduleDialog('Coding 1');

    expect(within(dialog).getByRole('combobox', { name: 'When' }).textContent).toBe(
      'Not scheduled yet',
    );
    await pickWhen(dialog, 'At a time');
    fill(dialog, 'Starts', '2026-11-25T09:15');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await whenListed()).toEqual(['Nov 25, 2026, 9:15 AM']);

    dialog = await openScheduleDialog('Coding 1');
    await pickWhen(dialog, 'Due by a date');
    fill(dialog, 'Due date', '2026-11-30');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(async () => expect(await whenListed()).toEqual(['Due Nov 30, 2026']));

    dialog = await openScheduleDialog('Coding 1');
    await pickWhen(dialog, 'Not scheduled yet');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(async () => expect(await whenListed()).toEqual(['Not scheduled yet']));
    expect(scheduled()).toEqual([
      { startsAt: new Date('2026-11-25T17:15:00.000Z') },
      { dueOn: '2026-11-30' },
      {},
    ]);
  });

  it('keeps the schedule when the user cancels', async () => {
    seed(round(1, 'take_home', { dueOn: '2026-12-01' }));
    await renderPage();

    const dialog = await openScheduleDialog('Take-home 1');

    fill(dialog, 'Due date', '2026-12-05');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(scheduled()).toEqual([]);
    expect(await whenListed()).toEqual(['Due Dec 1, 2026']);
  });

  it('keeps the editor open with what’s missing, sending nothing', async () => {
    seed(round(1, 'coding'));
    await renderPage();

    const dialog = await openScheduleDialog('Coding 1');

    await pickWhen(dialog, 'At a time');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Enter the date and time it starts.',
    );
    expect(scheduled()).toEqual([]);
  });

  it('closes the editor with Escape, sending nothing', async () => {
    seed(round(1, 'take_home', { dueOn: '2026-12-01' }));
    await renderPage();

    const dialog = await openScheduleDialog('Take-home 1');

    fill(dialog, 'Due date', '2026-12-05');
    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(scheduled()).toEqual([]);
    expect(await whenListed()).toEqual(['Due Dec 1, 2026']);
  });

  it('stays open on Escape while saving, so a failure still shows', async () => {
    seed(round(1, 'coding'));
    await renderPage();

    const dialog = await openScheduleDialog('Coding 1');
    const { override, release } = hold(serverError);

    fake.on('applications.scheduleRound', override);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await userEvent.keyboard('{Escape}');
    release();

    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Something went wrong. Please try again.',
    );
    expect(screen.getByRole('alertdialog')).toBe(dialog);
  });

  it('opens the editor again without the last failure', async () => {
    seed(round(1, 'coding'));
    await renderPage();

    let dialog = await openScheduleDialog('Coding 1');

    fake.on('applications.scheduleRound', serverError);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await within(dialog).findByRole('alert');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

    dialog = await openScheduleDialog('Coding 1');

    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('opens the editor again without the last message about what’s missing', async () => {
    seed(round(1, 'coding'));
    await renderPage();

    let dialog = await openScheduleDialog('Coding 1');

    await pickWhen(dialog, 'At a time');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await within(dialog).findByRole('alert');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

    dialog = await openScheduleDialog('Coding 1');

    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it.each([
    [500, 'Something went wrong. Please try again.'],
    [404, 'That round no longer exists.'],
  ])('keeps the editor open with the error when saving fails (%i)', async (code, message) => {
    seed(round(1, 'coding'));
    await renderPage();

    const dialog = await openScheduleDialog('Coding 1');

    if (code === 404) fake.removeRound(roundId(1));
    else fake.on('applications.scheduleRound', serverError);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect((await within(dialog).findByRole('alert')).textContent).toBe(message);
    expect(screen.getByRole('alertdialog')).toBe(dialog);
  });

  it('orders a take-home by its due day in the user’s time zone, not by midnight UTC', async () => {
    // 5 PM on Nov 30 here is 01:00 UTC on Dec 1, after the server's midnight for a take-home due
    // that day, so the server sends the take-home first.
    seed(
      round(1, 'take_home', { dueOn: '2026-12-01' }),
      round(2, 'coding', { startsAt: '2026-12-01T01:00:00.000Z' }),
      round(3, 'behavioral'),
      round(4, 'presentation', { dueOn: '2026-11-29' }),
    );
    await renderPage();

    expect(await whenListed()).toEqual([
      'Due Nov 29, 2026',
      'Nov 30, 2026, 5:00 PM',
      'Due Dec 1, 2026',
      'Not scheduled yet',
    ]);
  });

  it('renames Rounds of a type when a reschedule moves one ahead of another', async () => {
    seed(round(1, 'coding', { startsAt: '2026-12-01T18:00:00.000Z' }), round(2, 'coding'));
    await renderPage();

    expect(await listed()).toEqual(['Coding 1', 'Coding 2']);
    expect(await whenListed()).toEqual(['Dec 1, 2026, 10:00 AM', 'Not scheduled yet']);

    const dialog = await openScheduleDialog('Coding 2');

    await pickWhen(dialog, 'At a time');
    fill(dialog, 'Starts', '2026-11-20T09:00');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(async () =>
      expect(await whenListed()).toEqual(['Nov 20, 2026, 9:00 AM', 'Dec 1, 2026, 10:00 AM']),
    );
    expect(await listed()).toEqual(['Coding 1', 'Coding 2']);

    // "Coding 1" is now the Round that moved.
    const moved = await openScheduleDialog('Coding 1');

    expect(within(moved).getByLabelText<HTMLInputElement>('Starts').value).toBe('2026-11-20T09:00');
  });

  it('shows the Rounds in the server’s order, dated or not', async () => {
    seed(
      round(1, 'coding', { startsAt: '2026-11-25T18:00:00.000Z' }),
      round(2, 'take_home', { dueOn: '2026-12-01' }),
      round(3, 'behavioral'),
    );
    await renderPage();

    expect(await listed()).toEqual(['Coding 1', 'Take-home 1', 'Behavioral 1']);
    expect(await whenListed()).toEqual([
      'Nov 25, 2026, 10:00 AM',
      'Due Dec 1, 2026',
      'Not scheduled yet',
    ]);
  });
});

/** Where a Round's Self-rating is shown, e.g. `ratingGroup('Coding 1')`. */
const ratingGroup = (name: string) => screen.getByRole('group', { name: `${name} self-rating` });

/** What a Round's Self-rating shows: the rating line, then the note if there is one. */
const ratingShown = (name: string) => {
  const group = ratingGroup(name);
  const line = within(group).getByText(/^(Self-rating: \d of 5|Not rated yet)$/).textContent;
  const note = within(group).queryByRole('paragraph')?.textContent ?? null;

  return { line, note };
};

const openRatingDialog = async (name: string, button = `Rate ${name}`) => {
  await userEvent.click(await screen.findByRole('button', { name: button }));
  const dialog = await screen.findByRole('alertdialog', { name: `Rate ${name}` });

  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

  return dialog;
};

const pickRating = async (dialog: HTMLElement, label: string) => {
  await userEvent.click(within(dialog).getByRole('combobox', { name: 'Self-rating' }));
  await userEvent.click(await screen.findByRole('option', { name: label }));
};

const noteField = (dialog: HTMLElement) =>
  within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: 'What went wrong' });

const saveRating = async (dialog: HTMLElement) => {
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
};

describe('a Round’s Self-rating', () => {
  it('shows a Round as not rated yet, or with its rating and note', async () => {
    seed(
      round(1, 'coding', { selfRating: 2, ratingNote: 'Ran out of time' }),
      round(2, 'behavioral'),
      round(3, 'system_design', { selfRating: 5 }),
      round(4, 'presentation', { ratingNote: 'Slides too long' }),
    );
    await renderPage();
    await listed();

    expect(ratingShown('Coding 1')).toEqual({
      line: 'Self-rating: 2 of 5',
      note: 'Ran out of time',
    });
    expect(ratingShown('Behavioral 1')).toEqual({ line: 'Not rated yet', note: null });
    expect(ratingShown('System design 1')).toEqual({ line: 'Self-rating: 5 of 5', note: null });
    expect(ratingShown('Presentation 1')).toEqual({
      line: 'Not rated yet',
      note: 'Slides too long',
    });
  });

  // A rating or a note alone is something to edit; neither is something to give.
  it('offers to rate a Round with neither, and to edit one with a rating or a note', async () => {
    seed(
      round(1, 'coding', { selfRating: 2, ratingNote: 'Ran out of time' }),
      round(2, 'behavioral'),
      round(3, 'system_design', { selfRating: 5 }),
      round(4, 'presentation', { ratingNote: 'Slides too long' }),
    );
    await renderPage();
    await listed();

    const buttons = ['Coding 1', 'Behavioral 1', 'System design 1', 'Presentation 1'].map(
      (name) => within(ratingGroup(name)).getByRole('button').textContent,
    );

    expect(buttons).toEqual(['Edit rating', 'Rate', 'Edit rating', 'Edit rating']);
    expect(screen.getByRole('button', { name: 'Edit rating of Coding 1' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Rate Behavioral 1' })).toBeDefined();
  });

  it('says what the dialog is for, and that the note is optional', async () => {
    seed(round(1, 'coding'));
    await renderPage();

    const dialog = await openRatingDialog('Coding 1');

    expect(
      within(dialog).getByText('How it went, from 1 (badly) to 5 (well), and what went wrong.'),
    ).toBeDefined();
    expect(within(dialog).getByText('Optional, up to 2000 characters.')).toBeDefined();
  });

  it('closes with Escape, sending nothing', async () => {
    seed(round(1, 'coding', { selfRating: 2 }));
    await renderPage();

    const dialog = await openRatingDialog('Coding 1', 'Edit rating of Coding 1');

    await pickRating(dialog, '4');
    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(ratings()).toEqual([]);
    expect(ratingShown('Coding 1')).toEqual({ line: 'Self-rating: 2 of 5', note: null });
  });

  it('offers ratings from 1 (went badly) to 5 (went well), or none', async () => {
    seed(round(1, 'coding'));
    await renderPage();

    const dialog = await openRatingDialog('Coding 1');

    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Self-rating' }));

    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);

    expect(options).toEqual(['Not rated', '1 – Went badly', '2', '3', '4', '5 – Went well']);
  });

  it('rates a Round with a note, and shows them on it', async () => {
    seed(round(1, 'coding'), round(2, 'behavioral'));
    await renderPage();

    const dialog = await openRatingDialog('Coding 1');

    expect(within(dialog).getByRole('combobox', { name: 'Self-rating' }).textContent).toBe(
      'Not rated',
    );
    await pickRating(dialog, '4');
    await userEvent.type(noteField(dialog), 'Slow on the{Enter}second part');
    await saveRating(dialog);

    await waitFor(() =>
      expect(ratingShown('Coding 1')).toEqual({
        line: 'Self-rating: 4 of 5',
        note: 'Slow on the\nsecond part',
      }),
    );
    expect(ratingShown('Behavioral 1')).toEqual({ line: 'Not rated yet', note: null });
    expect(ratings()).toEqual([{ selfRating: 4, ratingNote: 'Slow on the\nsecond part' }]);
  });

  it('rates a Round without a note', async () => {
    seed(round(1, 'coding'));
    await renderPage();

    const dialog = await openRatingDialog('Coding 1');

    await pickRating(dialog, '1 – Went badly');
    await saveRating(dialog);

    await waitFor(() =>
      expect(ratingShown('Coding 1')).toEqual({ line: 'Self-rating: 1 of 5', note: null }),
    );
    expect(ratings()).toEqual([{ selfRating: 1 }]);
  });

  it('opens the dialog with the rating and note filled in, and changes them', async () => {
    seed(round(1, 'coding', { selfRating: 2, ratingNote: 'Nerves' }));
    await renderPage();

    const dialog = await openRatingDialog('Coding 1', 'Edit rating of Coding 1');

    expect(within(dialog).getByRole('combobox', { name: 'Self-rating' }).textContent).toBe('2');
    expect(noteField(dialog).value).toBe('Nerves');

    await pickRating(dialog, '5 – Went well');
    await userEvent.clear(noteField(dialog));
    await userEvent.type(noteField(dialog), 'Calmer');
    await saveRating(dialog);

    await waitFor(() =>
      expect(ratingShown('Coding 1')).toEqual({ line: 'Self-rating: 5 of 5', note: 'Calmer' }),
    );
    expect(ratings()).toEqual([{ selfRating: 5, ratingNote: 'Calmer' }]);
  });

  it('clears the note, keeping the rating', async () => {
    seed(round(1, 'coding', { selfRating: 3, ratingNote: 'Nerves' }));
    await renderPage();

    const dialog = await openRatingDialog('Coding 1', 'Edit rating of Coding 1');

    await userEvent.clear(noteField(dialog));
    await saveRating(dialog);

    await waitFor(() =>
      expect(ratingShown('Coding 1')).toEqual({ line: 'Self-rating: 3 of 5', note: null }),
    );
    expect(ratings()).toEqual([{ selfRating: 3 }]);
  });

  it('sends a note of only spaces as no note', async () => {
    seed(round(1, 'coding'));
    await renderPage();

    const dialog = await openRatingDialog('Coding 1');

    await pickRating(dialog, '3');
    await userEvent.type(noteField(dialog), '   ');
    await saveRating(dialog);

    expect(ratings()).toEqual([{ selfRating: 3 }]);
  });

  it('clears the rating, keeping the note', async () => {
    seed(round(1, 'coding', { selfRating: 3, ratingNote: 'Nerves' }));
    await renderPage();

    const dialog = await openRatingDialog('Coding 1', 'Edit rating of Coding 1');

    await pickRating(dialog, 'Not rated');
    await saveRating(dialog);

    await waitFor(() =>
      expect(ratingShown('Coding 1')).toEqual({ line: 'Not rated yet', note: 'Nerves' }),
    );
    expect(ratings()).toEqual([{ ratingNote: 'Nerves' }]);
  });

  it('clears both, back to not rated', async () => {
    seed(round(1, 'coding', { selfRating: 3, ratingNote: 'Nerves' }));
    await renderPage();

    const dialog = await openRatingDialog('Coding 1', 'Edit rating of Coding 1');

    await pickRating(dialog, 'Not rated');
    await userEvent.clear(noteField(dialog));
    await saveRating(dialog);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Rate Coding 1' })).toBeDefined(),
    );
    expect(ratingShown('Coding 1')).toEqual({ line: 'Not rated yet', note: null });
    expect(ratings()).toEqual([{}]);
  });

  it('keeps the rating when the user cancels', async () => {
    seed(round(1, 'coding', { selfRating: 2 }));
    await renderPage();

    const dialog = await openRatingDialog('Coding 1', 'Edit rating of Coding 1');

    await pickRating(dialog, '5 – Went well');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(ratings()).toEqual([]);
    expect(ratingShown('Coding 1')).toEqual({ line: 'Self-rating: 2 of 5', note: null });
  });

  it('accepts a note of 2000 characters, and says when one is longer, sending nothing', async () => {
    seed(round(1, 'coding'));
    await renderPage();

    const dialog = await openRatingDialog('Coding 1');
    const save = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Save' });

    fireEvent.change(noteField(dialog), { target: { value: 'x'.repeat(2001) } });

    expect(
      within(dialog).getByText('The note is 2001 characters; it can be at most 2000.'),
    ).toBeDefined();
    expect(noteField(dialog).getAttribute('aria-invalid')).toBe('true');
    expect(save.disabled).toBe(true);

    fireEvent.change(noteField(dialog), { target: { value: 'x'.repeat(2000) } });

    expect(within(dialog).queryByText(/it can be at most 2000/)).toBeNull();
    expect(save.disabled).toBe(false);

    await saveRating(dialog);

    expect(ratings()).toEqual([{ ratingNote: 'x'.repeat(2000) }]);
  });

  it.each([
    [500, 'Something went wrong. Please try again.'],
    [404, 'That round no longer exists.'],
  ])('keeps the dialog open with the error when saving fails (%i)', async (code, message) => {
    seed(round(1, 'coding'));
    await renderPage();

    const dialog = await openRatingDialog('Coding 1');

    if (code === 404) fake.removeRound(roundId(1));
    else fake.on('applications.rateRound', serverError);

    await pickRating(dialog, '3');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect((await within(dialog).findByRole('alert')).textContent).toBe(message);
    expect(screen.getByRole('alertdialog')).toBe(dialog);
  });

  it('opens again without the last failure', async () => {
    seed(round(1, 'coding'));
    await renderPage();

    let dialog = await openRatingDialog('Coding 1');

    fake.on('applications.rateRound', serverError);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await within(dialog).findByRole('alert');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

    dialog = await openRatingDialog('Coding 1');

    expect(within(dialog).queryByRole('alert')).toBeNull();
  });
});

/** Where a Round's Outcome is shown and set, e.g. `outcomeGroup('Coding 1')`. */
const outcomeGroup = (name: string) => screen.getByRole('group', { name: `${name} outcome` });

const outcomeMenu = (name: string) =>
  within(outcomeGroup(name)).getByRole('combobox', { name: 'Outcome' });

/** The Outcome a Round's menu shows. */
const outcomeShown = (name: string) => outcomeMenu(name).textContent;

const pickOutcome = async (name: string, label: string) => {
  await userEvent.click(outcomeMenu(name));
  await userEvent.click(await screen.findByRole('option', { name: label }));
};

describe('a Round’s Outcome', () => {
  it('shows a new Round as pending', async () => {
    await renderPage();
    await addRound('Coding');
    await listed();

    expect(outcomeShown('Coding 1')).toBe('Pending');
  });

  it('shows each Round’s Outcome', async () => {
    seed(
      round(1, 'coding', { outcome: 'passed', outcomeSetByUser: true }),
      round(2, 'behavioral'),
      round(3, 'system_design', { outcome: 'failed', outcomeSetByUser: true }),
      round(4, 'presentation', { outcome: 'unknown', outcomeSetByUser: true }),
    );
    await renderPage();
    await listed();

    expect(
      ['Coding 1', 'Behavioral 1', 'System design 1', 'Presentation 1'].map(outcomeShown),
    ).toEqual(['Passed', 'Pending', 'Failed', 'Unknown (never told)']);
  });

  it('marks an inferred Outcome, apart from one the user set', async () => {
    seed(
      round(1, 'coding', { outcome: 'passed' }),
      round(2, 'behavioral', { outcome: 'passed', outcomeSetByUser: true }),
      round(3, 'system_design', { outcome: 'failed' }),
      round(4, 'presentation'),
    );
    await renderPage();
    await listed();

    expect(
      ['Coding 1', 'Behavioral 1', 'System design 1', 'Presentation 1'].map(outcomeShown),
    ).toEqual(['Passed (inferred)', 'Passed', 'Failed (inferred)', 'Pending']);
  });

  it('shows the Outcomes inferred from a Round it adds, sending the user’s time zone', async () => {
    seed(round(1, 'coding'));
    // The API passes the pending Rounds before the new one.
    fake.on('applications.createRound', () => {
      fake.changeRound(roundId(1), { outcome: 'passed' });

      return undefined;
    });
    await renderPage();
    await listed();

    await addRound('Behavioral');

    await waitFor(() => expect(outcomeShown('Coding 1')).toBe('Passed (inferred)'));
    expect(fake.received('applications.createRound').map(({ timeZone }) => timeZone)).toEqual([
      'America/Los_Angeles',
    ]);
  });

  it('sets an inferred Outcome as the user’s when they change it', async () => {
    seed(round(1, 'coding', { outcome: 'passed' }));
    await renderPage();
    await listed();

    await pickOutcome('Coding 1', 'Failed');

    await waitFor(() => expect(outcomeShown('Coding 1')).toBe('Failed'));
    expect(stored()[0]).toMatchObject({ outcome: 'failed', outcomeSetByUser: true });
  });

  it('offers the four Outcomes, in order', async () => {
    seed(round(1, 'coding'));
    await renderPage();
    await listed();

    await userEvent.click(outcomeMenu('Coding 1'));

    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);

    expect(options).toEqual(['Pending', 'Passed', 'Failed', 'Unknown (never told)']);
  });

  it('sets it to passed, failed, unknown and back to pending, on that Round only', async () => {
    seed(round(1, 'coding'), round(2, 'behavioral'));
    await renderPage();
    await listed();

    for (const [outcome, label] of [
      ['passed', 'Passed'],
      ['failed', 'Failed'],
      ['unknown', 'Unknown (never told)'],
      ['pending', 'Pending'],
    ] as const) {
      await pickOutcome('Coding 1', label);

      await waitFor(() => expect(outcomeShown('Coding 1')).toBe(label));
      expect(stored()[0]).toMatchObject({ outcome, outcomeSetByUser: true });
    }

    expect(outcomes()).toEqual([
      { outcome: 'passed' },
      { outcome: 'failed' },
      { outcome: 'unknown' },
      { outcome: 'pending' },
    ]);
    expect(outcomeShown('Behavioral 1')).toBe('Pending');
  });

  it('shows the picked Outcome while it saves, and takes no other until it has', async () => {
    seed(round(1, 'coding'));
    await renderPage();
    await listed();

    const { override, release: answer } = hold();

    fake.on('applications.setRoundOutcome', override);

    await pickOutcome('Coding 1', 'Passed');

    await waitFor(() => expect(outcomes()).toEqual([{ outcome: 'passed' }]));
    expect(outcomeShown('Coding 1')).toBe('Passed');
    expect(outcomeMenu('Coding 1').hasAttribute('data-disabled')).toBe(true);

    answer();

    await waitFor(() => expect(outcomeMenu('Coding 1').hasAttribute('data-disabled')).toBe(false));
    expect(outcomeShown('Coding 1')).toBe('Passed');
  });

  it.each([
    [500, 'Something went wrong. Please try again.'],
    [404, 'That round no longer exists.'],
  ])('says why the Outcome couldn’t be saved (%i), keeping the old one', async (code, message) => {
    seed(round(1, 'coding', { outcome: 'passed', outcomeSetByUser: true }));
    await renderPage();
    await listed();

    if (code === 404) fake.removeRound(roundId(1));
    else fake.on('applications.setRoundOutcome', serverError);

    await pickOutcome('Coding 1', 'Failed');

    expect((await within(outcomeGroup('Coding 1')).findByRole('alert')).textContent).toBe(message);
    expect(outcomeShown('Coding 1')).toBe('Passed');
  });
});

describe('the Agenda, when a Round changes', () => {
  /** The application's page with the Agenda beside it, sharing one cache as in the app. */
  const renderWithAgenda = async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const router = createTestRouter(
      <>
        <ApplicationPage applicationId={ACME_ID} />
        <AgendaPage />
      </>,
      '/elsewhere',
    );

    render(
      <SnackbarProvider>
        <QueryClientProvider client={queryClient}>
          <TestRouterProvider router={router} />
        </QueryClientProvider>
      </SnackbarProvider>,
    );

    await screen.findByRole('heading', { name: 'Rounds' });
  };

  const agenda = () => screen.getByRole('region', { name: 'Agenda' });

  /** The Agenda's day headings. */
  const agendaDays = () =>
    within(agenda())
      .queryAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent);

  it('shows a Round once it’s added', async () => {
    await renderWithAgenda();
    await within(agenda()).findByText(/Nothing coming up/);

    await addRound('Coding');

    await waitFor(() => expect(agendaDays()).toEqual(['Not scheduled yet']));
  });

  it('moves a Round once it’s rescheduled', async () => {
    seed(round(1, 'coding'));
    await renderWithAgenda();
    await waitFor(() => expect(agendaDays()).toEqual(['Not scheduled yet']));

    const dialog = await openScheduleDialog('Coding 1');

    await pickWhen(dialog, 'Due by a date');
    fill(dialog, 'Due date', '2099-01-02');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(agendaDays()).toEqual([
        new Date(2099, 0, 2).toLocaleDateString(undefined, { dateStyle: 'full' }),
      ]),
    );
  });

  it('drops a Round once it’s deleted', async () => {
    seed(round(1, 'coding'));
    await renderWithAgenda();
    await waitFor(() => expect(agendaDays()).toEqual(['Not scheduled yet']));

    const dialog = await openDeleteDialog('Coding 1');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(await within(agenda()).findByText(/Nothing coming up/)).toBeDefined();
  });
});
