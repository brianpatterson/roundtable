// The web app's typed client (packages/shared/src/client.ts) against the real server: the same
// code the browser runs, with fetch pointed at the app in-process instead of the network.
import { Schema } from 'effect';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ApplicationNotFound,
  MAX_SKILLS,
  MAX_TAGS,
  Unauthorized,
  isApplicationId,
} from '@roundtable/contract';
import { ApiError, makeApiClient } from '@roundtable/contract/client';
import { setupTestApp, signUp } from './helpers.js';

const t = setupTestApp();

const clientFor = (cookie?: string) =>
  makeApiClient({ baseUrl: 'http://localhost', fetch: t.fetchAs(cookie) });

let api: ReturnType<typeof clientFor>;

beforeAll(() => t.migrate());

beforeEach(async () => {
  await t.reset();
  api = clientFor((await signUp(t)).cookie);
});

afterAll(() => t.close());

describe('the web client', () => {
  it('creates, lists, updates and deletes, with dates decoded', async () => {
    const created = await api.createApplication({ company: ' Acme ', jobTitle: 'SWE' });

    expect(created).toMatchObject({ company: 'Acme', jobTitle: 'SWE', status: 'applied' });
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.appliedAt).toEqual(created.createdAt);

    const updated = await api.updateApplication(created.id, { status: 'offer' });

    expect(updated.status).toBe('offer');
    expect(updated.appliedAt).toEqual(created.appliedAt);
    expect(await api.listApplications()).toEqual([updated]);
    expect(await api.getApplication(created.id)).toEqual(updated);

    const saved = await api.createApplication({
      company: 'Globex',
      jobTitle: 'SWE',
      status: 'saved',
    });

    expect(saved).toMatchObject({ status: 'saved', appliedAt: null });

    await api.deleteApplication(saved.id);
    await api.deleteApplication(created.id);
    expect(await api.listApplications()).toEqual([]);
  });

  it('adds, lists and deletes Rounds, with dates decoded', async () => {
    const application = await api.createApplication({ company: 'Acme', jobTitle: 'SWE' });
    const round = await api.createRound(application.id, { interviewType: 'system_design' });

    expect(round).toMatchObject({ applicationId: application.id, interviewType: 'system_design' });
    expect(round.createdAt).toBeInstanceOf(Date);
    expect(await api.listRounds(application.id)).toEqual([round]);

    await api.deleteRound(application.id, round.id);
    expect(await api.listRounds(application.id)).toEqual([]);
    await expect(api.deleteRound(application.id, round.id)).rejects.toThrow(
      'That round no longer exists.',
    );
  });

  it('adds and removes a Round’s Tags, and says when it has too many', async () => {
    const application = await api.createApplication({ company: 'Acme', jobTitle: 'SWE' });
    const round = await api.createRound(application.id, { interviewType: 'coding' });

    expect(round.tags).toEqual([]);
    expect((await api.addTag(application.id, round.id, ' React ')).tags).toEqual(['React']);
    expect((await api.addTag(application.id, round.id, 'CI/CD')).tags).toEqual(['React', 'CI/CD']);
    expect((await api.removeTag(application.id, round.id, 'ci/cd')).tags).toEqual(['React']);

    for (let i = 2; i <= MAX_TAGS; i++) await api.addTag(application.id, round.id, `tag ${i}`);

    await expect(api.addTag(application.id, round.id, 'one more')).rejects.toThrow(
      'A round can have at most 10 tags.',
    );
    await expect(api.addTag(application.id, crypto.randomUUID(), 'SQL')).rejects.toThrow(
      'That round no longer exists.',
    );
  });

  it('schedules a Round, sending its start as an instant', async () => {
    const application = await api.createApplication({ company: 'Acme', jobTitle: 'SWE' });
    const startsAt = new Date('2026-11-25T15:30:00Z');

    const round = await api.createRound(application.id, {
      interviewType: 'coding',
      startsAt,
      durationMinutes: 60,
    });

    expect(round).toMatchObject({ startsAt, durationMinutes: 60, dueOn: null });

    const due = await api.scheduleRound(application.id, round.id, { dueOn: '2026-11-28' });

    expect(due).toMatchObject({ startsAt: null, durationMinutes: null, dueOn: '2026-11-28' });
    expect(await api.listRounds(application.id)).toEqual([due]);
    await expect(
      api.scheduleRound(application.id, round.id, { durationMinutes: 30 }),
    ).rejects.toThrow('Check what you entered and try again.');
  });

  it('reads the Agenda in a time zone, and refuses an invalid one before it is sent', async () => {
    const application = await api.createApplication({ company: 'Acme', jobTitle: 'SWE' });

    // The Agenda carries a Round's prep tasks but not its Prep notes.
    const { prepNotes: _prepNotes, ...round } = await api.createRound(application.id, {
      interviewType: 'coding',
    });

    expect(await api.agenda('America/New_York')).toEqual([
      { ...round, company: 'Acme', jobTitle: 'SWE' },
    ]);
    expect(await api.agenda()).toHaveLength(1);
    await expect(api.agenda('+05:30')).rejects.toThrow('Check what you entered and try again.');
  });

  it('rates a Round, and refuses a rating outside 1–5 before it is sent', async () => {
    const application = await api.createApplication({ company: 'Acme', jobTitle: 'SWE' });
    const round = await api.createRound(application.id, { interviewType: 'coding' });

    const rated = await api.rateRound(application.id, round.id, {
      selfRating: 2,
      ratingNote: 'Froze on recursion',
    });

    expect(rated).toMatchObject({ selfRating: 2, ratingNote: 'Froze on recursion' });
    expect(await api.listRounds(application.id)).toEqual([rated]);
    await expect(api.rateRound(application.id, round.id, { selfRating: 6 })).rejects.toThrow(
      ApiError,
    );
  });

  it('sets a Round’s Outcome, recording that the user set it', async () => {
    const application = await api.createApplication({ company: 'Acme', jobTitle: 'SWE' });
    const round = await api.createRound(application.id, { interviewType: 'coding' });

    expect(round).toMatchObject({ outcome: 'pending', outcomeSetByUser: false });

    const passed = await api.setRoundOutcome(application.id, round.id, { outcome: 'passed' });

    expect(passed).toMatchObject({ outcome: 'passed', outcomeSetByUser: true });
    expect(await api.listRounds(application.id)).toEqual([passed]);
  });

  it('keeps a Round’s Prep notes and prep tasks, with dates decoded', async () => {
    const application = await api.createApplication({ company: 'Acme', jobTitle: 'SWE' });
    const round = await api.createRound(application.id, { interviewType: 'coding' });
    const skill = await api.createSkill({ name: 'Algorithms' });

    expect(round).toMatchObject({ prepNotes: null, prepTasks: [] });

    const noted = await api.setPrepNotes(application.id, round.id, 'Review graphs');

    expect(noted.prepNotes).toBe('Review graphs');

    const added = await api.addPrepTask(application.id, round.id, {
      title: ' Practice BFS ',
      skillId: skill.id,
    });

    const [task] = added.prepTasks;

    expect(task).toMatchObject({ title: 'Practice BFS', skillId: skill.id, completedAt: null });

    const done = await api.updatePrepTask(application.id, round.id, task?.id ?? '', {
      done: true,
    });

    expect(done.prepTasks[0]?.completedAt).toBeInstanceOf(Date);
    expect(await api.listRounds(application.id)).toEqual([done]);
    expect((await api.agenda()).map((item) => item.prepTasks)).toEqual([done.prepTasks]);

    const removed = await api.deletePrepTask(application.id, round.id, task?.id ?? '');

    expect(removed.prepTasks).toEqual([]);
    await expect(api.deletePrepTask(application.id, round.id, task?.id ?? '')).rejects.toThrow(
      'That prep task no longer exists.',
    );
  });

  it('adds, lists, renames, archives and restores Skills, with dates decoded', async () => {
    const skill = await api.createSkill({ name: ' System design ' });

    expect(skill).toMatchObject({ name: 'System design', archivedAt: null });
    expect(skill.createdAt).toBeInstanceOf(Date);

    const archived = await api.updateSkill(skill.id, { name: 'Systems', archived: true });

    expect(archived.archivedAt).toBeInstanceOf(Date);
    expect(await api.listSkills()).toEqual([archived]);
    expect(await api.updateSkill(skill.id, { archived: false })).toEqual({
      ...skill,
      name: 'Systems',
    });
  });

  it('says when a Skill’s name is taken, and to restore an archived one instead', async () => {
    const skill = await api.createSkill({ name: 'System design' });

    await expect(api.createSkill({ name: 'system design' })).rejects.toThrow(
      'You already have a skill with that name.',
    );

    await api.updateSkill(skill.id, { archived: true });

    await expect(api.createSkill({ name: 'SYSTEM DESIGN' })).rejects.toThrow(
      'You have an archived skill with that name. Restore it instead.',
    );
    await expect(api.updateSkill(crypto.randomUUID(), { archived: true })).rejects.toThrow(
      'That skill no longer exists.',
    );
  });

  it('says when the user has too many Skills', async () => {
    for (let i = 0; i < MAX_SKILLS; i++) await api.createSkill({ name: `Skill ${i}` });

    await expect(api.createSkill({ name: 'One more' })).rejects.toThrow(
      `You can have at most ${MAX_SKILLS} skills, archived ones included.`,
    );
  });

  it('reads the public auth config without a session', async () => {
    expect(await clientFor().authConfig()).toEqual({ providers: [] });
  });

  it('turns typed errors into messages for the user', async () => {
    const missing = api.updateApplication(crypto.randomUUID(), { status: 'offer' });

    await expect(missing).rejects.toThrow(ApiError);
    await expect(missing).rejects.toThrow('That application no longer exists.');
    await expect(api.getApplication(crypto.randomUUID())).rejects.toHaveProperty(
      'cause',
      expect.any(ApplicationNotFound),
    );
  });

  it('reads another user’s application as not found', async () => {
    const theirs = await api.createApplication({ company: 'Acme', jobTitle: 'SWE' });
    const mine = clientFor((await signUp(t)).cookie);

    await expect(mine.getApplication(theirs.id)).rejects.toHaveProperty(
      'cause',
      expect.any(ApplicationNotFound),
    );
  });

  it('tells an application id from a malformed one', () => {
    expect(isApplicationId(crypto.randomUUID())).toBe(true);
    expect(isApplicationId('not-an-id')).toBe(false);
  });

  it('rejects with the Unauthorized error as the cause when there is no session', async () => {
    // The web shell routes it to identity by its cause; the client gives it no wording of its own.
    const signedOut = clientFor().listApplications();

    await expect(signedOut).rejects.toThrow(ApiError);
    await expect(signedOut).rejects.toHaveProperty('cause', expect.any(Unauthorized));
  });

  it('sends a report signed out, without its query string, and says when the hour’s limit is reached', async () => {
    const signedOut = clientFor();
    const payload = { description: ' It broke ', pagePath: '/reset-password?token=secret' };

    for (let i = 0; i < 5; i++) {
      expect(await signedOut.createReport(payload)).toEqual({ id: expect.any(String) });
    }

    await expect(signedOut.createReport(payload)).rejects.toThrow(
      "We've received a lot of reports in the last hour. Please try again later.",
    );
  });

  it('refuses invalid input before sending it', async () => {
    let requests = 0;

    const counting = makeApiClient({
      baseUrl: 'http://localhost',
      fetch: (input, init) => {
        requests += 1;

        return t.fetchAs()(input, init);
      },
    });

    // In plain words, without the schema's own wording, which stays in `cause` for logs and Sentry.
    const refusedPlainly = async (request: Promise<unknown>) => {
      try {
        await request;
      } catch (error) {
        if (!(error instanceof ApiError)) return expect.fail(`expected an ApiError, got ${error}`);

        expect(error.message).toBe('Check what you entered and try again.');
        expect(Schema.isSchemaError(error.cause)).toBe(true);

        return;
      }

      expect.fail('the client sent a body the contract rejects');
    };

    await refusedPlainly(counting.createApplication({ company: '  ', jobTitle: 'SWE' }));
    await refusedPlainly(
      counting.createApplication({ company: 'A', jobTitle: 'B', jobUrl: 'javascript:alert(1)' }),
    );
    await refusedPlainly(counting.addTag(crypto.randomUUID(), crypto.randomUUID(), ' '));
    await refusedPlainly(counting.addTag(crypto.randomUUID(), crypto.randomUUID(), 'x'.repeat(41)));
    expect(requests).toBe(0);
  });
});
