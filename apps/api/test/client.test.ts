// The web app's typed client (packages/shared/src/client.ts) against the real server: the same
// code the browser runs, with fetch pointed at the app in-process instead of the network.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApplicationNotFound, MAX_TAGS, Unauthorized, isApplicationId } from '@roundtable/contract';
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
    ).rejects.toThrow('A duration needs a start time');
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

    await expect(counting.createApplication({ company: '  ', jobTitle: 'SWE' })).rejects.toThrow(
      'must not be blank',
    );
    await expect(
      counting.createApplication({ company: 'A', jobTitle: 'B', jobUrl: 'javascript:alert(1)' }),
    ).rejects.toThrow('must be an http(s) URL');
    await expect(counting.addTag(crypto.randomUUID(), crypto.randomUUID(), ' ')).rejects.toThrow(
      'must not be blank',
    );
    await expect(
      counting.addTag(crypto.randomUUID(), crypto.randomUUID(), 'x'.repeat(41)),
    ).rejects.toThrow('must be at most 40 characters');
    expect(requests).toBe(0);
  });
});
