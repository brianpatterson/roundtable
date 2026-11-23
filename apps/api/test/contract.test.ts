// The Effect HttpApi contract (packages/contract) is the only schema for the API: the
// server decodes requests with it and the web client encodes them with it (ADR-0022). These tests
// pin down what it accepts, that real responses decode, and that it lists the routes served.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ErrorReporter, Exit, Schema } from 'effect';
import { HttpApi } from 'effect/http-api';
import * as contract from '@roundtable/contract';
import { setupTestApp, signUp } from './helpers.js';

const long = (n: number) => 'x'.repeat(n);

type Case = [input: unknown, decoded: object | false];

// Each case: the input, and what it decodes to (or `false` when it's rejected). These began as
// the Zod parity cases from step 3, so they're what the API accepted before the Effect contract.
describe('what the contract accepts', () => {
  const minimal = { company: 'A', jobTitle: 'B' };

  const createCases = {
    minimal: [
      { company: 'Acme', jobTitle: 'SWE' },
      { company: 'Acme', jobTitle: 'SWE' },
    ],
    'trims text': [
      { company: '  Acme  ', jobTitle: ' SWE ' },
      { company: 'Acme', jobTitle: 'SWE' },
    ],
    'https url': [
      { ...minimal, jobUrl: 'https://example.com/jobs/1' },
      { ...minimal, jobUrl: 'https://example.com/jobs/1' },
    ],
    'http url': [
      { ...minimal, jobUrl: 'http://example.com' },
      { ...minimal, jobUrl: 'http://example.com' },
    ],
    'null url': [
      { ...minimal, jobUrl: null },
      { ...minimal, jobUrl: null },
    ],
    status: [
      { ...minimal, status: 'offer' },
      { ...minimal, status: 'offer' },
    ],
    '200 chars': [
      { company: long(200), jobTitle: long(200) },
      { company: long(200), jobTitle: long(200) },
    ],
    '200 chars once trimmed': [
      { company: ` ${long(200)} `, jobTitle: 'B' },
      { company: long(200), jobTitle: 'B' },
    ],
    'unknown key is dropped': [{ ...minimal, extra: true }, minimal],
    'empty company': [{ company: '', jobTitle: 'B' }, false],
    'blank company': [{ company: '   ', jobTitle: 'B' }, false],
    '201 chars': [{ company: long(201), jobTitle: 'B' }, false],
    'missing jobTitle': [{ company: 'A' }, false],
    'number company': [{ company: 5, jobTitle: 'B' }, false],
    'javascript url': [{ ...minimal, jobUrl: 'javascript:alert(1)' }, false],
    'data url': [{ ...minimal, jobUrl: 'data:text/html,x' }, false],
    'ftp url': [{ ...minimal, jobUrl: 'ftp://x.y' }, false],
    'not a url': [{ ...minimal, jobUrl: 'not a url' }, false],
    '2001-char url': [{ ...minimal, jobUrl: `https://e.com/${long(1987)}` }, false],
    'unknown status': [{ ...minimal, status: 'ghosted' }, false],
    // Folded into interviewing (ADR-0045).
    'screening status': [{ ...minimal, status: 'screening' }, false],
    'saved status': [
      { ...minimal, status: 'saved' },
      { ...minimal, status: 'saved' },
    ],
    // The server sets it.
    'applied date is dropped': [{ ...minimal, appliedAt: '2020-01-01T00:00:00.000Z' }, minimal],
  } satisfies Record<string, Case>;

  const updateCases = {
    status: [{ status: 'offer' }, { status: 'offer' }],
    'trims company': [{ company: '  Acme ' }, { company: 'Acme' }],
    'clears url': [{ jobUrl: null }, { jobUrl: null }],
    empty: [{}, false],
    'only unknown keys': [{ extra: 1 }, false],
    'empty company': [{ company: '' }, false],
    'data url': [{ jobUrl: 'data:text/html,x' }, false],
    'screening status': [{ status: 'screening' }, false],
    'saved status': [{ status: 'saved' }, { status: 'saved' }],
  } satisfies Record<string, Case>;

  const idCases = {
    'v4 uuid': ['00000000-0000-4000-8000-000000000000', true],
    'random uuid': [crypto.randomUUID(), true],
    'uppercase uuid': [crypto.randomUUID().toUpperCase(), true],
    'not a uuid': ['abc', false],
    'too short': ['00000000-0000-4000-8000-00000000000', false],
  } satisfies Record<string, [id: string, valid: boolean]>;

  it.each(Object.entries(createCases))('create: %s', (_name, [input, decoded]) => {
    const exit = Schema.decodeUnknownExit(contract.CreateApplication)(input);

    if (decoded === false) expect(Exit.isFailure(exit)).toBe(true);
    else expect(exit).toEqual(Exit.succeed(decoded));
  });

  const roundCases = {
    coding: [{ interviewType: 'coding' }, { interviewType: 'coding' }],
    'take-home': [{ interviewType: 'take_home' }, { interviewType: 'take_home' }],
    'unknown key is dropped': [
      { interviewType: 'other', applicationId: 'x' },
      { interviewType: 'other' },
    ],
    'unknown type': [{ interviewType: 'onsite' }, false],
    'missing type': [{}, false],
    'a start, as a Date': [
      { interviewType: 'coding', startsAt: '2026-11-25T15:30:00Z' },
      { interviewType: 'coding', startsAt: new Date('2026-11-25T15:30:00Z') },
    ],
    'a start and a duration': [
      { interviewType: 'coding', startsAt: '2026-11-25T15:30:00Z', durationMinutes: 480 },
      { interviewType: 'coding', startsAt: new Date('2026-11-25T15:30:00Z'), durationMinutes: 480 },
    ],
    'a due date': [
      { interviewType: 'take_home', dueOn: '2024-02-29' },
      { interviewType: 'take_home', dueOn: '2024-02-29' },
    ],
    'all null': [
      { interviewType: 'coding', startsAt: null, durationMinutes: null, dueOn: null },
      { interviewType: 'coding', startsAt: null, durationMinutes: null, dueOn: null },
    ],
    'a start and a due date': [
      { interviewType: 'coding', startsAt: '2026-11-25T15:30:00Z', dueOn: '2026-11-25' },
      false,
    ],
    'a duration alone': [{ interviewType: 'coding', durationMinutes: 30 }, false],
    'a duration of 4': [
      { interviewType: 'coding', startsAt: '2026-11-25T15:30:00Z', durationMinutes: 4 },
      false,
    ],
    'a duration of 481': [
      { interviewType: 'coding', startsAt: '2026-11-25T15:30:00Z', durationMinutes: 481 },
      false,
    ],
    'a malformed start': [{ interviewType: 'coding', startsAt: 'soon' }, false],
    'a due date not in the calendar': [{ interviewType: 'coding', dueOn: '2025-02-29' }, false],
    'a due date as a day/month string': [{ interviewType: 'coding', dueOn: '25/11/2026' }, false],
  } satisfies Record<string, Case>;

  const scheduleCases = {
    'not scheduled': [{}, {}],
    'a due date': [{ dueOn: '2026-11-28' }, { dueOn: '2026-11-28' }],
    'a start and a due date': [{ startsAt: '2026-11-25T15:30:00Z', dueOn: '2026-11-28' }, false],
    'a duration alone': [{ durationMinutes: 30 }, false],
    'a duration as text': [{ startsAt: '2026-11-25T15:30:00Z', durationMinutes: '30' }, false],
  } satisfies Record<string, Case>;

  it.each(Object.entries(scheduleCases))('schedule: %s', (_name, [input, decoded]) => {
    const exit = Schema.decodeUnknownExit(contract.RoundSchedule)(input);

    if (decoded === false) expect(Exit.isFailure(exit)).toBe(true);
    else expect(exit).toEqual(Exit.succeed(decoded));
  });

  const ratingCases = {
    'nothing (clears it)': [{}, {}],
    'nulls (clears it)': [
      { selfRating: null, ratingNote: null },
      { selfRating: null, ratingNote: null },
    ],
    'a rating of 1': [{ selfRating: 1 }, { selfRating: 1 }],
    'a rating of 5 with a note': [
      { selfRating: 5, ratingNote: 'Ran out of time' },
      { selfRating: 5, ratingNote: 'Ran out of time' },
    ],
    'a note alone': [{ ratingNote: 'Nerves' }, { ratingNote: 'Nerves' }],
    'a note of 2000 characters': [
      { ratingNote: 'x'.repeat(2000) },
      { ratingNote: 'x'.repeat(2000) },
    ],
    'a rating of 0': [{ selfRating: 0 }, false],
    'a rating of 6': [{ selfRating: 6 }, false],
    'a fractional rating': [{ selfRating: 3.5 }, false],
    'a rating as text': [{ selfRating: '3' }, false],
    'a note of 2001 characters': [{ ratingNote: 'x'.repeat(2001) }, false],
  } satisfies Record<string, Case>;

  it.each(Object.entries(ratingCases))('rating: %s', (_name, [input, decoded]) => {
    const exit = Schema.decodeUnknownExit(contract.RoundRating)(input);

    if (decoded === false) expect(Exit.isFailure(exit)).toBe(true);
    else expect(exit).toEqual(Exit.succeed(decoded));
  });

  const outcomeCases = {
    pending: [{ outcome: 'pending' }, { outcome: 'pending' }],
    passed: [{ outcome: 'passed' }, { outcome: 'passed' }],
    failed: [{ outcome: 'failed' }, { outcome: 'failed' }],
    unknown: [{ outcome: 'unknown' }, { outcome: 'unknown' }],
    'one outside the four': [{ outcome: 'advanced' }, false],
    'another case': [{ outcome: 'PASSED' }, false],
    null: [{ outcome: null }, false],
    missing: [{}, false],
  } satisfies Record<string, Case>;

  it.each(Object.entries(outcomeCases))('outcome: %s', (_name, [input, decoded]) => {
    const exit = Schema.decodeUnknownExit(contract.RoundOutcome)(input);

    if (decoded === false) expect(Exit.isFailure(exit)).toBe(true);
    else expect(exit).toEqual(Exit.succeed(decoded));
  });

  // The web app sends what the user typed, so the client must refuse the same schedules first.
  it('encodes a schedule, and refuses an inconsistent one before it is sent', () => {
    const encode = Schema.encodeUnknownExit(contract.CreateRound);
    const startsAt = new Date('2026-11-25T15:30:00Z');

    expect(encode({ interviewType: 'coding', startsAt, durationMinutes: 60 })).toEqual(
      Exit.succeed({
        interviewType: 'coding',
        startsAt: '2026-11-25T15:30:00.000Z',
        durationMinutes: 60,
      }),
    );
    expect(Exit.isFailure(encode({ interviewType: 'coding', durationMinutes: 60 }))).toBe(true);
    expect(Exit.isFailure(encode({ interviewType: 'coding', startsAt, dueOn: '2026-11-25' }))).toBe(
      true,
    );
  });

  it.each(Object.entries(roundCases))('round: %s', (_name, [input, decoded]) => {
    const exit = Schema.decodeUnknownExit(contract.CreateRound)(input);

    if (decoded === false) expect(Exit.isFailure(exit)).toBe(true);
    else expect(exit).toEqual(Exit.succeed(decoded));
  });

  const tagCases = {
    plain: [{ tag: 'React' }, { tag: 'React' }],
    trimmed: [{ tag: '  live debugging ' }, { tag: 'live debugging' }],
    '40 characters once trimmed': [{ tag: ` ${'x'.repeat(40)} ` }, { tag: 'x'.repeat(40) }],
    '41 characters': [{ tag: 'x'.repeat(41) }, false],
    blank: [{ tag: '   ' }, false],
    empty: [{ tag: '' }, false],
    missing: [{}, false],
    'not a string': [{ tag: 1 }, false],
  } satisfies Record<string, Case>;

  it.each(Object.entries(tagCases))('tag: %s', (_name, [input, decoded]) => {
    const exit = Schema.decodeUnknownExit(contract.RoundTag)(input);

    if (decoded === false) expect(Exit.isFailure(exit)).toBe(true);
    else expect(exit).toEqual(Exit.succeed(decoded));
  });

  it('reads a Round from a server before Tags as having none', () => {
    const round = Schema.decodeSync(contract.Round)({
      id: 'r',
      applicationId: 'a',
      interviewType: 'coding',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    });

    expect(round.tags).toEqual([]);
  });

  // The browser's time zone, sent with a new Round and a status change for inferred Outcomes.
  const timeZoneCases = {
    'a city': ['America/New_York', true],
    'a deeper name': ['America/Argentina/Buenos_Aires', true],
    UTC: ['UTC', true],
    'an offset': ['+05:30', false],
    'a name Intl doesn’t know': ['Mars/Olympus_Mons', false],
    empty: ['', false],
    'with a space': ['America/New York', false],
  } satisfies Record<string, [string, boolean]>;

  it.each(Object.entries(timeZoneCases))('time zone: %s', (_name, [timeZone, valid]) => {
    const round = Schema.decodeExit(contract.CreateRound)({
      interviewType: 'coding',
      timeZone,
    });

    const update = Schema.decodeExit(contract.UpdateApplication)({
      status: 'rejected',
      timeZone,
    });

    expect([Exit.isSuccess(round), Exit.isSuccess(update)]).toEqual([valid, valid]);
  });

  it('refuses an update with only a time zone: it changes nothing', () => {
    const exit = Schema.decodeExit(contract.UpdateApplication)({ timeZone: 'UTC' });

    expect(Exit.isFailure(exit)).toBe(true);
  });

  it.each(Object.entries(updateCases))('update: %s', (_name, [input, decoded]) => {
    const exit = Schema.decodeUnknownExit(contract.UpdateApplication)(input);

    if (decoded === false) expect(Exit.isFailure(exit)).toBe(true);
    else expect(exit).toEqual(Exit.succeed(decoded));
  });

  const IdParams = Schema.Struct({ id: Schema.String.check(Schema.isUUID()) });

  it.each(Object.entries(idCases))('id: %s', (_name, [id, valid]) => {
    expect(Exit.isSuccess(Schema.decodeExit(IdParams)({ id }))).toBe(valid);
  });

  const report = { description: 'It broke', pagePath: '/' };

  const reportCases = {
    minimal: [report, report],
    'trims the description': [{ ...report, description: '  It broke \n' }, report],
    'reply email': [
      { ...report, replyEmail: 'me@example.com' },
      { ...report, replyEmail: 'me@example.com' },
    ],
    'null reply email': [
      { ...report, replyEmail: null },
      { ...report, replyEmail: null },
    ],
    '2000 chars': [
      { ...report, description: long(2000) },
      { ...report, description: long(2000) },
    ],
    'drops the query and hash': [
      { ...report, pagePath: '/reset-password?token=secret#top' },
      { ...report, pagePath: '/reset-password' },
    ],
    'unknown key is dropped': [{ ...report, userId: 'someone' }, report],
    'empty description': [{ ...report, description: '' }, false],
    'blank description': [{ ...report, description: '  \n ' }, false],
    '2001 chars': [{ ...report, description: long(2001) }, false],
    'malformed email': [{ ...report, replyEmail: 'me@' }, false],
    'email with spaces': [{ ...report, replyEmail: 'me @example.com' }, false],
    'missing page': [{ description: 'It broke' }, false],
    'any path, as on a mistyped link': [
      { ...report, pagePath: '/a%20b/~me/@x:y' },
      { ...report, pagePath: '/a%20b/~me/@x:y' },
    ],
    'a long path keeps 500 characters': [
      { ...report, pagePath: `/${long(600)}` },
      { ...report, pagePath: `/${long(499)}` },
    ],
    'page that is a URL': [{ ...report, pagePath: 'https://example.com/' }, false],
    'page that is not a path': [{ ...report, pagePath: 'settings' }, false],
    'with diagnostics': [
      { ...report, diagnostics: { theme: 'dark', requests: [], errors: [] } },
      { ...report, diagnostics: { theme: 'dark', requests: [], errors: [] } },
    ],
    'diagnostics with an unknown theme': [{ ...report, diagnostics: { theme: 'pink' } }, false],
    'a negative status': [
      {
        ...report,
        diagnostics: { requests: [{ method: 'GET', path: '/', status: -1, secondsBefore: 0 }] },
      },
      false,
    ],
  } satisfies Record<string, Case>;

  it.each(Object.entries(reportCases))('report: %s', (_name, [input, decoded]) => {
    const exit = Schema.decodeUnknownExit(contract.CreateReport)(input);

    if (decoded === false) expect(Exit.isFailure(exit)).toBe(true);
    else expect(exit).toEqual(Exit.succeed(decoded));
  });

  // The typed client encodes request bodies before sending them, so text must trim on the way
  // out too: a form value of " Acme" is sent as "Acme" rather than refused in the browser.
  it('encodes text trimmed, and refuses blank text before it is sent', () => {
    const encode = Schema.encodeUnknownExit(contract.CreateApplication);

    expect(encode({ company: ' Acme ', jobTitle: 'SWE\n' })).toEqual(
      Exit.succeed({ company: 'Acme', jobTitle: 'SWE' }),
    );
    expect(Exit.isFailure(encode({ company: '  ', jobTitle: 'SWE' }))).toBe(true);
    expect(Exit.isFailure(encode({ company: long(201), jobTitle: 'SWE' }))).toBe(true);
  });
});

// The web app decodes responses with the contract, so it must read what a server one release
// either side of it sends: a tab left open across a deploy or a rollback (ADR-0014, ADR-0045).
describe('responses from the release before the status rework still decode', () => {
  const before = {
    id: '00000000-0000-4000-8000-000000000001',
    company: 'Acme',
    jobTitle: 'SWE',
    jobUrl: null,
    status: 'interviewing',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
  };

  it('reads a missing applied date as null', () => {
    expect(Schema.decodeUnknownSync(contract.Application)(before)).toMatchObject({
      status: 'interviewing',
      appliedAt: null,
    });
  });

  // Release 3 of ADR-0045: no deployed release returns `screening` any more, so there's one list
  // of statuses and a response carrying it is malformed.
  it('rejects a response with screening', () => {
    const screening = { ...before, status: 'screening' };

    expect(Exit.isFailure(Schema.decodeUnknownExit(contract.Application)(screening))).toBe(true);
  });

  it('reads a Round from before scheduling as not scheduled yet', () => {
    const round = {
      id: '00000000-0000-4000-8000-000000000002',
      applicationId: before.id,
      interviewType: 'coding',
      createdAt: before.createdAt,
      updatedAt: before.updatedAt,
    };

    expect(Schema.decodeUnknownSync(contract.Round)(round)).toMatchObject({
      startsAt: null,
      durationMinutes: null,
      dueOn: null,
      selfRating: null,
      ratingNote: null,
      outcome: 'pending',
      outcomeSetByUser: false,
    });
  });

  it('reads a saved application', () => {
    const saved = { ...before, status: 'saved', appliedAt: null };

    expect(Schema.decodeUnknownSync(contract.Application)(saved).status).toBe('saved');
  });
});

describe('real responses from the current API decode with the contract', () => {
  const t = setupTestApp();
  let cookie: string;

  beforeAll(() => t.migrate());
  beforeEach(async () => {
    await t.reset();
    ({ cookie } = await signUp(t));
  });
  afterAll(() => t.close());

  it('applications, health and auth-config', async () => {
    const created = await t.inject({
      method: 'POST',
      url: '/api/applications',
      headers: { cookie },
      payload: { company: 'Acme', jobTitle: 'SWE', jobUrl: 'https://example.com' },
    });

    const id = Schema.decodeUnknownSync(contract.Application)(created.json()).id;

    const list = await t.inject({
      method: 'GET',
      url: '/api/applications',
      headers: { cookie },
    });

    const one = await t.inject({
      method: 'GET',
      url: `/api/applications/${id}`,
      headers: { cookie },
    });

    const health = await t.inject({ method: 'GET', url: '/api/health' });
    const authConfig = await t.inject({ method: 'GET', url: '/api/auth-config' });

    const receipt = await t.inject({
      method: 'POST',
      url: '/api/reports',
      payload: { description: 'It broke', pagePath: '/' },
    });

    const decoded = Schema.decodeUnknownSync(contract.Application)(created.json());

    expect(decoded.createdAt).toBeInstanceOf(Date);
    expect(decoded.createdAt.toISOString()).toBe(created.json<{ createdAt: string }>().createdAt);
    expect(() =>
      Schema.decodeUnknownSync(Schema.Array(contract.Application))(list.json()),
    ).not.toThrow();
    expect(() => Schema.decodeUnknownSync(contract.Application)(one.json())).not.toThrow();
    expect(() => Schema.decodeUnknownSync(contract.Health)(health.json())).not.toThrow();
    expect(() => Schema.decodeUnknownSync(contract.AuthConfig)(authConfig.json())).not.toThrow();
    expect(receipt.statusCode).toBe(201);
    expect(() => Schema.decodeUnknownSync(contract.ReportReceipt)(receipt.json())).not.toThrow();
  });
});

describe('the contract matches the routes the server answers', () => {
  const t = setupTestApp();

  afterAll(() => t.close());

  it('same methods and paths, except Better Auth (mounted separately)', async () => {
    const served = await t.routes();

    const declared = new Set<string>();

    HttpApi.reflect(contract.RoundtableApi, {
      onGroup: () => {},
      onEndpoint: ({ endpoint }) => declared.add(`${endpoint.method} ${endpoint.path}`),
    });

    expect([...declared].sort()).toEqual(served);
  });
});

describe('expected errors stay out of Sentry', () => {
  // A new error class fails the first test until it's listed here and checked below. A 5xx error
  // is unexpected by definition and may be reported; a 4xx one must set ErrorReporter.ignore.
  it('lists every error class in the contract', () => {
    const errorClassNames = Object.entries(contract)
      .filter(([, value]) => value instanceof Function && value.prototype instanceof Error)
      .map(([name]) => name);

    expect(errorClassNames.sort()).toEqual([
      'ApplicationNotFound',
      'ReportNotFound',
      'ReportRateLimited',
      'RoundNotFound',
      'TooManyTags',
      'Unauthorized',
    ]);
  });

  it('ApplicationNotFound, RoundNotFound and ReportNotFound (404), TooManyTags (400), Unauthorized (401) and ReportRateLimited (429) set ErrorReporter.ignore', () => {
    expect(new contract.TooManyTags()[ErrorReporter.ignore]).toBe(true);
    expect(new contract.ApplicationNotFound()[ErrorReporter.ignore]).toBe(true);
    expect(new contract.RoundNotFound()[ErrorReporter.ignore]).toBe(true);
    expect(new contract.ReportNotFound()[ErrorReporter.ignore]).toBe(true);
    expect(new contract.Unauthorized()[ErrorReporter.ignore]).toBe(true);
    expect(new contract.ReportRateLimited()[ErrorReporter.ignore]).toBe(true);
  });
});
