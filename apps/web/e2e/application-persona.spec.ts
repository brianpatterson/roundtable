import { expect, test } from '@playwright/test';
import { expectAccessible, screenshotThemes } from './support';

test('picks an application’s Persona when adding it, then clears and chooses it on its page', async ({
  page,
}, testInfo) => {
  // Each project and each retry adds its own, so no attempt finds another's (the database is
  // reset per run, not per attempt, and every test shares one user).
  const suffix = `${testInfo.project.name} ${testInfo.retry}`;
  const personaName = `Platform ${suffix}`;
  const company = `Initech ${suffix}`;

  // A Persona to pick.
  await page.goto('/personas');

  const personaField = page.getByRole('textbox', { name: 'Persona name' });

  await personaField.fill(personaName);
  await personaField.press('Enter');
  await expect(
    page.getByRole('list', { name: 'Personas' }).getByRole('link', { name: personaName }),
  ).toBeVisible();

  // The new-application form offers it, None by default.
  await page.goto('/applications');
  await page.getByLabel('Company').fill(company);
  await page.getByLabel('Job title').fill('Platform Engineer');

  const formPersona = page.getByRole('combobox', { name: 'Persona' });

  await expect(formPersona).toHaveText('None');
  await formPersona.click();
  await page.getByRole('option', { name: personaName, exact: true }).click();
  await expect(formPersona).toHaveText(personaName);
  await expectAccessible(page);
  await screenshotThemes(page, testInfo, 'new-application-persona-picked');
  await page.getByRole('button', { name: 'Add as applied' }).click();
  await expect(formPersona).toHaveText('None');

  // Its page shows the Persona it was added with.
  await page.getByRole('link', { name: company }).click();
  await expect(page.getByRole('heading', { name: company })).toBeVisible();

  const persona = page.getByRole('combobox', { name: 'Persona' });

  await expect(persona).toHaveText(personaName);

  // Clear it: a snackbar confirms, and it stays cleared once read again from the server.
  await persona.click();
  await page.getByRole('option', { name: 'None', exact: true }).click();
  await expect(page.getByText('Persona cleared.')).toBeVisible();
  await page.reload();
  await expect(persona).toHaveText('None');

  // Choose it again.
  await persona.click();
  await page.getByRole('option', { name: personaName, exact: true }).click();
  await expect(page.getByText(`Persona set to ${personaName}.`)).toBeVisible();
  await expect(persona).toHaveText(personaName);
  await expectAccessible(page);
  await screenshotThemes(page, testInfo, 'application-persona-chosen');

  await page.reload();
  await expect(persona).toHaveText(personaName);
});
