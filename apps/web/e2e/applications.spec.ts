import { expect, test } from '@playwright/test';
import { expectAccessible, screenshotThemes } from './support';

test('add an application and open its page', async ({ page }, testInfo) => {
  // Each project adds its own, so the two never find the other's row.
  const company = `Acme ${testInfo.project.name}`;

  await page.goto('/');
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
