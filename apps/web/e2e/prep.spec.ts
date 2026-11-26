import { expect, test } from '@playwright/test';
import { expectAccessible, screenshotThemes } from './support';

test('writes Prep notes and keeps a checklist of prep tasks on a Round', async ({
  page,
}, testInfo) => {
  // Each project and each retry adds its own, so no attempt finds another's rows (the database
  // is reset per run, not per attempt, and every test shares one user).
  const suffix = `${testInfo.project.name} ${testInfo.retry}`;
  const company = `Initech ${suffix}`;
  const skillName = `Caching ${suffix}`;

  // Added through the API with the signed-in user's cookies, as the pages would.
  const created = await page.request.post('/api/applications', {
    data: { company, jobTitle: 'Backend Engineer', status: 'interviewing' },
  });

  expect(created.status()).toBe(201);

  // SAFETY: a 201 from POST /api/applications is the contract's Application, which has an id.
  const { id } = (await created.json()) as { id: string };

  const round = await page.request.post(`/api/applications/${id}/rounds`, {
    data: { interviewType: 'system_design' },
  });

  expect(round.status()).toBe(201);

  const skill = await page.request.post('/api/skills', { data: { name: skillName } });

  expect(skill.status()).toBe(201);

  await page.goto(`/applications/${id}`);

  const prep = page.getByRole('region', { name: /^System design 1 prep/ });

  await expect(prep.getByRole('heading', { name: 'Prep' })).toBeVisible();

  // Notes, with their line breaks.
  await prep.getByRole('button', { name: 'Add notes for System design 1' }).click();

  const notesDialog = page.getByRole('alertdialog', { name: 'Prep notes for System design 1' });

  await notesDialog
    .getByRole('textbox', { name: 'Prep notes' })
    .fill('Read their engineering blog\nAsk about on-call');
  await expectAccessible(page);
  await screenshotThemes(page, testInfo, 'prep-notes-dialog');
  await notesDialog.getByRole('button', { name: 'Save' }).click();
  await expect(notesDialog).toBeHidden();
  await expect(prep.getByText('Read their engineering blog')).toHaveText(
    'Read their engineering blog\nAsk about on-call',
  );

  // A task naming the Skill.
  const form = page.getByRole('form', { name: 'Add a prep task to System design 1' });

  await form.getByRole('textbox', { name: 'Task' }).fill('Practise cache invalidation');
  await form.getByRole('combobox', { name: 'Skill' }).click();
  await page.getByRole('option', { name: skillName }).click();
  await form.getByRole('button', { name: 'Add task' }).click();

  const task = prep.getByRole('checkbox', { name: 'Practise cache invalidation' });

  await expect(task).toBeVisible();
  await expect(task).not.toBeChecked();
  await expect(prep.getByText(skillName)).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'System design 1 prep, 0 of 1 done' }),
  ).toBeVisible();

  // Tick it.
  await task.click();
  await expect(task).toBeChecked();
  await expect(
    page.getByRole('region', { name: 'System design 1 prep, 1 of 1 done' }),
  ).toBeVisible();
  await expectAccessible(page);
  await screenshotThemes(page, testInfo, 'prep-task-done');

  // Edit it from the keyboard: focus goes back to Edit when the dialog closes.
  const edit = prep.getByRole('button', { name: 'Edit task Practise cache invalidation' });

  await edit.focus();
  await page.keyboard.press('Enter');

  const editDialog = page.getByRole('alertdialog', { name: 'Edit prep task' });
  const title = editDialog.getByRole('textbox', { name: 'Title' });

  await expect(title).toHaveValue('Practise cache invalidation');
  await expectAccessible(page);
  await screenshotThemes(page, testInfo, 'prep-task-edit-dialog');
  await title.fill('Design a cache for the feed');
  await editDialog.getByRole('button', { name: 'Save' }).click();
  await expect(editDialog).toBeHidden();

  const edited = prep.getByRole('button', { name: 'Edit task Design a cache for the feed' });

  await expect(edited).toBeFocused();
  await expect(prep.getByRole('checkbox', { name: 'Design a cache for the feed' })).toBeChecked();

  // Escape closes the dialog without saving, and focus goes back too.
  await page.keyboard.press('Enter');
  await expect(editDialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(editDialog).toBeHidden();
  await expect(edited).toBeFocused();

  // Delete it.
  await prep.getByRole('button', { name: 'Delete task Design a cache for the feed' }).click();
  await expect(prep.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'System design 1 prep' })).toBeVisible();
});

test('lists the Persona’s Skills first in the prep task’s Skill picker', async ({
  page,
}, testInfo) => {
  const suffix = `${testInfo.project.name} ${testInfo.retry}`;
  const personaName = `Data engineer ${suffix}`;
  const ownSkill = `Pipelines ${suffix}`;
  const otherSkill = `Negotiation ${suffix}`;

  // Added through the API with the signed-in user's cookies, as the pages would.
  const skillIdOf = async (name: string) => {
    const created = await page.request.post('/api/skills', { data: { name } });

    expect(created.status()).toBe(201);

    // SAFETY: a 201 from POST /api/skills is the contract's Skill, which has an id.
    return ((await created.json()) as { id: string }).id;
  };

  const pipelines = await skillIdOf(ownSkill);

  await skillIdOf(otherSkill);

  const persona = await page.request.post('/api/personas', { data: { name: personaName } });

  expect(persona.status()).toBe(201);

  // SAFETY: a 201 from POST /api/personas is the contract's Persona, which has an id.
  const { id: personaId } = (await persona.json()) as { id: string };

  const ticked = await page.request.post(`/api/personas/${personaId}/skills`, {
    data: { skillId: pipelines },
  });

  expect(ticked.status()).toBe(200);

  const created = await page.request.post('/api/applications', {
    data: {
      company: `Hooli ${suffix}`,
      jobTitle: 'Data Engineer',
      status: 'interviewing',
      personaId,
    },
  });

  expect(created.status()).toBe(201);

  // SAFETY: a 201 from POST /api/applications is the contract's Application, which has an id.
  const { id } = (await created.json()) as { id: string };

  const round = await page.request.post(`/api/applications/${id}/rounds`, {
    data: { interviewType: 'coding' },
  });

  expect(round.status()).toBe(201);

  await page.goto(`/applications/${id}`);
  await expect(page.getByRole('combobox', { name: 'Persona' })).toHaveText(personaName);

  // From the keyboard: "No skill" first, then the Persona's group, then the others.
  const form = page.getByRole('form', { name: 'Add a prep task to Coding 1' });

  await form.getByRole('textbox', { name: 'Task' }).fill('Build a backfill');
  await form.getByRole('combobox', { name: 'Skill' }).focus();
  await page.keyboard.press('ArrowDown');

  const listbox = page.getByRole('listbox');
  const own = listbox.getByRole('group', { name: personaName });
  const others = listbox.getByRole('group', { name: 'Other skills' });

  await expect(own.getByRole('option')).toHaveText([ownSkill]);
  await expect(others.getByRole('option', { name: otherSkill })).toBeVisible();
  await expect(others.getByRole('option', { name: ownSkill })).toHaveCount(0);
  await expect(listbox.getByRole('option').first()).toHaveText('No skill');
  await expectAccessible(page);
  await screenshotThemes(page, testInfo, 'prep-skill-picker-persona-first');

  await expect(listbox.getByRole('option', { name: 'No skill' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(own.getByRole('option', { name: ownSkill })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(form.getByRole('combobox', { name: 'Skill' })).toHaveText(ownSkill);
  await expect(form.getByRole('combobox', { name: 'Skill' })).toBeFocused();
});
