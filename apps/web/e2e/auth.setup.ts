import { expect, test as setup } from '@playwright/test';
import { AUTH_STATE } from './paths';
import { confirmationLink } from './support';

// Signs up through the real form and the real confirmation email, once per run, and saves the
// session for every other test. The database is fresh each run, so the address is always new.
setup('sign up and confirm the email', async ({ page }) => {
  const email = `browser-${Date.now()}@example.com`;

  await page.goto('/');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Name').fill('Browser Test');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText(`Check ${email} for a link`)).toBeVisible();

  // Following the link confirms the address and signs in (autoSignInAfterVerification).
  await page.goto(await confirmationLink(email));
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

  await page.context().storageState({ path: AUTH_STATE });
});
