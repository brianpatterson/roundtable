import { expect, test } from '@playwright/test';
import { expectAccessible, screenshotThemes } from './support';

test.use({ storageState: { cookies: [], origins: [] } });

test('the sign-in page', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  await expectAccessible(page);
  await screenshotThemes(page, testInfo, 'sign-in');
});

test('the problem report dialog works from the keyboard and returns focus', async ({
  page,
}, testInfo) => {
  await page.goto('/');

  const opener = page.getByRole('button', { name: 'Report a problem' });

  await opener.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('alertdialog', { name: 'Report a problem' });

  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel(/what went wrong/i)).toBeFocused();
  await expectAccessible(page);
  await screenshotThemes(page, testInfo, 'report-problem');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});
