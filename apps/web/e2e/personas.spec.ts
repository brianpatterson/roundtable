import { expect, test } from '@playwright/test';
import { expectAccessible, screenshotThemes } from './support';

test('adds a Persona, ticks a Skill on its page and archives it', async ({ page }, testInfo) => {
  // Each project and each retry adds its own, so no attempt finds another's (the database is
  // reset per run, not per attempt, and every test shares one user).
  const suffix = `${testInfo.project.name} ${testInfo.retry}`;
  const personaName = `Backend ${suffix}`;
  const skillName = `Databases ${suffix}`;

  // A Skill to pick, from the Skills page.
  await page.goto('/skills');

  const skillField = page.getByRole('textbox', { name: 'Skill name' });

  await skillField.fill(skillName);
  await skillField.press('Enter');
  await expect(page.getByRole('list', { name: 'Skills' }).getByText(skillName)).toBeVisible();

  // The Personas page, from the header.
  const nav = page.getByRole('navigation', { name: 'Pages' });

  await nav.getByRole('link', { name: 'Personas' }).click();
  await expect(page).toHaveURL('/personas');
  await expect(page.getByRole('heading', { name: 'Personas', level: 2 })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Personas' })).toHaveAttribute('aria-current', 'page');

  // Add.
  const field = page.getByRole('textbox', { name: 'Persona name' });

  await field.fill(personaName);
  await field.press('Enter');

  const personas = page.getByRole('list', { name: 'Personas' });
  const link = personas.getByRole('link', { name: personaName });

  await expect(link).toBeVisible();
  await expect(field).toHaveValue('');
  await expect(
    personas.getByRole('listitem').filter({ has: page.getByRole('link', { name: personaName }) }),
  ).toContainText('0 skills');
  await expectAccessible(page);
  await screenshotThemes(page, testInfo, 'personas-list');

  // Its page: tick the Skill, from the keyboard.
  await link.click();
  await expect(page.getByRole('heading', { name: personaName })).toBeVisible();

  const skills = page.getByRole('group', { name: 'Skills' });
  const skill = skills.getByRole('checkbox', { name: skillName });

  await expect(skill).not.toBeChecked();
  await skill.focus();
  await page.keyboard.press('Space');
  await expect(skill).toBeChecked();
  // Read again from the server: the tick stuck.
  await page.reload();
  await expect(skills.getByRole('checkbox', { name: skillName })).toBeChecked();
  await expectAccessible(page);
  await screenshotThemes(page, testInfo, 'persona-page-skill-ticked');

  // Rename opens a dialog, and Escape closes it with focus back on Rename.
  const rename = page.getByRole('button', { name: 'Rename' });

  await rename.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alertdialog', { name: `Rename ${personaName}` })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toBeHidden();
  await expect(rename).toBeFocused();

  // Archive, from the keyboard: a snackbar confirms it, and focus moves to Restore.
  await page.getByRole('button', { name: 'Archive' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(`Archived ${personaName}.`)).toBeVisible();
  await expect(page.getByText(/This persona is archived/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore' })).toBeFocused();
  await expectAccessible(page);
  await screenshotThemes(page, testInfo, 'persona-page-archived');

  // Back on the list, it's in the Archived section, with its Skill counted.
  await page.getByRole('link', { name: 'Back to my personas' }).click();
  await expect(personas.getByRole('link', { name: personaName })).toHaveCount(0);

  // The Archived section starts collapsed, and its toggle opens it.
  const archivedLink = page.getByRole('link', { name: personaName });
  const toggle = page.getByRole('button', { name: /^Archived \(\d+\)$/ });

  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(archivedLink).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(archivedLink).toBeVisible();

  const archived = page.getByRole('list', { name: 'Archived' });

  await expect(
    archived.getByRole('listitem').filter({ has: page.getByRole('link', { name: personaName }) }),
  ).toContainText('1 skill');
});
