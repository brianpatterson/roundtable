import { expect, test } from '@playwright/test';
import { expectAccessible, screenshotThemes } from './support';

test('adds, renames, archives and restores a Skill on the Skills page', async ({
  page,
}, testInfo) => {
  // Each project and each retry adds its own, so no attempt finds another's row (the database
  // is reset per run, not per attempt, and every test shares one user).
  const name = `Systems ${testInfo.project.name} ${testInfo.retry}`;
  const renamed = `Distributed ${name}`;

  await page.goto('/');

  const nav = page.getByRole('navigation', { name: 'Pages' });

  await nav.getByRole('link', { name: 'Skills' }).click();
  await expect(page).toHaveURL('/skills');
  await expect(page.getByRole('heading', { name: 'Skills' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Skills' })).toHaveAttribute('aria-current', 'page');

  // Add.
  const field = page.getByRole('textbox', { name: 'Skill name' });

  await field.fill(name);
  await field.press('Enter');

  const skills = page.getByRole('list', { name: 'Skills' });

  await expect(skills.getByRole('listitem').filter({ hasText: name })).toBeVisible();
  await expect(field).toHaveValue('');

  // The same name again is refused, with the reason by the field and the text kept.
  await field.fill(name);
  await field.press('Enter');
  await expect(page.getByText('You already have a skill with that name.')).toBeVisible();
  await expect(field).toHaveValue(name);
  await expectAccessible(page);
  await screenshotThemes(page, testInfo, 'skills-name-taken');
  await field.fill('');

  // Rename, from the keyboard: the dialog takes focus and gives it back to Rename.
  const renameButton = page.getByRole('button', { name: `Rename ${name}` });

  await renameButton.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('alertdialog', { name: `Rename ${name}` });
  const newName = dialog.getByRole('textbox', { name: 'Name' });

  await expect(newName).toHaveValue(name);
  await expectAccessible(page);
  await screenshotThemes(page, testInfo, 'skills-rename-dialog');

  await newName.fill(renamed);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(skills.getByRole('listitem').filter({ hasText: renamed })).toBeVisible();
  await expect(page.getByRole('button', { name: `Rename ${renamed}` })).toBeFocused();

  // Escape closes the dialog without saving, and focus goes back too.
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alertdialog', { name: `Rename ${renamed}` })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toBeHidden();
  await expect(page.getByRole('button', { name: `Rename ${renamed}` })).toBeFocused();

  // Archive: it leaves the list for the collapsed Archived section, and a snackbar confirms it.
  // From the keyboard: the pressed button goes, and focus moves to the Archived toggle.
  await page.getByRole('button', { name: `Archive ${renamed}` }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(`Archived ${renamed}.`)).toBeVisible();
  await expect(skills.getByRole('listitem').filter({ hasText: renamed })).toHaveCount(0);

  const toggle = page.getByRole('button', { name: /^Archived \(\d+\)$/ });

  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  const archived = page.getByRole('list', { name: 'Archived' });

  await expect(archived.getByRole('listitem').filter({ hasText: renamed })).toBeVisible();
  await expectAccessible(page);
  await screenshotThemes(page, testInfo, 'skills-archived');

  // Restore: back in the list, with focus on the toggle, or on the heading if it was the last one.
  await archived.getByRole('button', { name: `Restore ${renamed}` }).focus();
  await page.keyboard.press('Enter');
  await expect(skills.getByRole('listitem').filter({ hasText: renamed })).toBeVisible();
  await expect(archived.getByRole('listitem').filter({ hasText: renamed })).toHaveCount(0);
  // Other projects' archived Skills share this user, so either can be the one left.
  await expect(page.locator(':focus')).toHaveAccessibleName(/^(Archived \(\d+\)|Skills)$/);
});
