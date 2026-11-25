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
