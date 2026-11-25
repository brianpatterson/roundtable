import { expect, test } from '@playwright/test';
import { expectAccessible, screenshotThemes } from './support';

const MS_PER_DAY = 86_400_000;

test('the Agenda shows an upcoming Round and leads to its application and back', async ({
  page,
}, testInfo) => {
  // Each project and each retry adds its own, so no attempt finds another's row (the database
  // is reset per run, not per attempt).
  const company = `Globex ${testInfo.project.name} ${testInfo.retry}`;

  // Added through the API with the signed-in user's cookies, as the page would.
  const created = await page.request.post('/api/applications', {
    data: { company, jobTitle: 'Platform Engineer', status: 'interviewing' },
  });

  expect(created.status()).toBe(201);

  // SAFETY: a 201 from POST /api/applications is the contract's Application, which has an id.
  const { id } = (await created.json()) as { id: string };

  const round = await page.request.post(`/api/applications/${id}/rounds`, {
    data: {
      interviewType: 'system_design',
      startsAt: new Date(Date.now() + 2 * MS_PER_DAY).toISOString(),
      durationMinutes: 60,
    },
  });

  expect(round.status()).toBe(201);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Agenda' })).toBeVisible();

  const nav = page.getByRole('navigation', { name: 'Pages' });

  await expect(nav.getByRole('link', { name: 'Agenda' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('link', { name: 'Applications' })).not.toHaveAttribute('aria-current');

  const link = page.getByRole('link', { name: `${company} – Platform Engineer` });

  await expect(link).toBeVisible();
  await expect(page.getByRole('listitem').filter({ has: link })).toContainText('System design');
  await expectAccessible(page);
  await screenshotThemes(page, testInfo, 'agenda');

  await link.click();
  await expect(page.getByRole('heading', { name: company })).toBeVisible();
  await expect(page).toHaveURL(`/applications/${id}`);

  await nav.getByRole('link', { name: 'Applications' }).click();
  await expect(page).toHaveURL('/applications');
  await expect(nav.getByRole('link', { name: 'Applications' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('link', { name: company, exact: true })).toBeVisible();

  await nav.getByRole('link', { name: 'Agenda' }).click();
  await expect(page).toHaveURL('/');
  await expect(link).toBeVisible();
});

test('the Agenda shows each Round’s Prep progress, kept current from the application page', async ({
  page,
}, testInfo) => {
  const company = `Umbrella ${testInfo.project.name} ${testInfo.retry}`;

  const created = await page.request.post('/api/applications', {
    data: { company, jobTitle: 'Site Reliability Engineer', status: 'interviewing' },
  });

  expect(created.status()).toBe(201);

  // SAFETY: a 201 from POST /api/applications is the contract's Application, which has an id.
  const { id } = (await created.json()) as { id: string };

  const addRound = async (interviewType: string, days: number) => {
    const added = await page.request.post(`/api/applications/${id}/rounds`, {
      data: { interviewType, startsAt: new Date(Date.now() + days * MS_PER_DAY).toISOString() },
    });

    expect(added.status()).toBe(201);

    // SAFETY: a 201 from POST …/rounds is the contract's Round, which has an id.
    return ((await added.json()) as { id: string }).id;
  };

  // A Round with two prep tasks, one of them done, and a Round with none.
  const coding = await addRound('coding', 2);

  await addRound('behavioral', 3);

  const addTask = async (title: string) => {
    const added = await page.request.post(`/api/applications/${id}/rounds/${coding}/prep-tasks`, {
      data: { title },
    });

    expect(added.status()).toBe(201);

    // SAFETY: a 201 from POST …/prep-tasks is the contract's Round, its new task last.
    const { prepTasks } = (await added.json()) as { prepTasks: { id: string }[] };

    return prepTasks.at(-1)?.id;
  };

  const first = await addTask('Practise graph search');

  await addTask('Review their API');

  const ticked = await page.request.patch(
    `/api/applications/${id}/rounds/${coding}/prep-tasks/${first}`,
    { data: { done: true } },
  );

  expect(ticked.status()).toBe(200);

  await page.goto('/');

  const rows = page.getByRole('listitem').filter({
    has: page.getByRole('link', { name: `${company} – Site Reliability Engineer` }),
  });

  const codingRow = rows.filter({ hasText: 'Coding' });
  const behavioralRow = rows.filter({ hasText: 'Behavioral' });

  await expect(codingRow).toContainText('Prep 1 of 2 done');
  await expect(behavioralRow).toBeVisible();
  await expect(behavioralRow).not.toContainText('Prep');
  await expectAccessible(page);
  await screenshotThemes(page, testInfo, 'agenda-prep-progress');

  // Tick the other task on the application page, then come back to the Agenda.
  await codingRow.getByRole('link').click();
  await expect(page.getByRole('heading', { name: company })).toBeVisible();

  const task = page
    .getByRole('region', { name: /^Coding 1 prep/ })
    .getByRole('checkbox', { name: 'Review their API' });

  await task.click();
  await expect(task).toBeChecked();
  await expect(page.getByRole('region', { name: 'Coding 1 prep, 2 of 2 done' })).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Pages' })
    .getByRole('link', { name: 'Agenda' })
    .click();
  await expect(page).toHaveURL('/');
  await expect(codingRow).toContainText('Prep done');
  await expect(codingRow).not.toContainText('of 2');
  await expectAccessible(page);
  await screenshotThemes(page, testInfo, 'agenda-prep-done');
});
