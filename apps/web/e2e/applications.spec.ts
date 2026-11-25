import { expect, test } from '@playwright/test';
import { expectAccessible, screenshotThemes } from './support';

test('add an application and open its page', async ({ page }, testInfo) => {
  // Each project and each retry adds its own, so no attempt finds another's row (the database
  // is reset per run, not per attempt).
  const company = `Acme ${testInfo.project.name} ${testInfo.retry}`;

  await page.goto('/applications');
  await page.getByLabel('Company').fill(company);
  await page.getByLabel('Job title').fill('Staff Engineer');
  await page.getByRole('button', { name: 'Add as applied' }).click();

  const link = page.getByRole('link', { name: company });

  await expect(link).toBeVisible();
  await expectAccessible(page);
  await screenshotThemes(page, testInfo, 'applications');

  await link.click();
  await expect(page.getByRole('heading', { name: company })).toBeVisible();
  await expectAccessible(page);
  await screenshotThemes(page, testInfo, 'application');
});
