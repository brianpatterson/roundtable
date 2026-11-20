// "Report a problem" (ADR-0038) through the real endpoint and the app_test database. GitHub is a
// stand-in (`openIssue`); the owner's email is captured like every other email in tests.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ErrorEvent } from '@sentry/node';
import { eq } from 'drizzle-orm';
import { Schema } from 'effect';
import { ReportRateLimited } from '@roundtable/contract';
import { Sentry } from '../../platform/observability/error-tracking.js';
import { setupTestApp, signUp, type Json, type TestApp } from '#test/helpers';
import type { NewIssue } from './github.js';
import { REPORT_ISSUE_LABELS, REPORTS_PER_HOUR, browserFamily } from './handlers.js';
import { userReports } from './schema.js';

const OWNER = 'owner@example.com';

const FIREFOX =
  'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 secret-extension/1.2';

const SECRET_WORDS = 'my landlord Jane Doe, card 4111 1111 1111 1111';

/** A different client address per call, unless the test pins one. */
const randomIp = () => `203.0.113.${Math.floor(Math.random() * 250)}-${crypto.randomUUID()}`;

function report(
  t: TestApp,
  payload: Json,
  { cookie, ip = randomIp() }: { cookie?: string; ip?: string } = {},
) {
  return t.inject({
    method: 'POST',
    url: '/api/reports',
    headers: {
      'user-agent': FIREFOX,
      'x-forwarded-for': `10.0.0.1, ${ip}`,
      ...(cookie && { cookie }),
    },
    payload,
  });
}

const valid = {
  description: `  Sign in with GitHub showed an error page: ${SECRET_WORDS}  `,
  replyEmail: 'me@example.com',
  pagePath: '/settings/profile',
};

const storedReports = (t: TestApp) => t.db.select().from(userReports);

describe('reporting a problem', () => {
  const issues: NewIssue[] = [];

  const t = setupTestApp({
    env: { REPORTS_EMAIL: OWNER, SENTRY_RELEASE: 'roundtable-api:abc123' },
    openIssue: async (issue) => {
      issues.push(issue);

      return { url: `https://github.com/owner/repo/issues/${issues.length}` };
    },
  });

  beforeAll(() => t.migrate());

  beforeEach(async () => {
    await t.reset();
    issues.length = 0;
  });

  afterAll(() => t.close());

  it('stores a signed-out report with its context and answers with its id', async () => {
    const res = await report(t, { ...valid, pagePath: '/reset-password?token=abc#x' });

    expect(res.statusCode).toBe(201);
    const { id } = res.json<{ id: string }>();
    const [row] = await t.db.select().from(userReports).where(eq(userReports.id, id));

    expect(row).toMatchObject({
      id,
      description: `Sign in with GitHub showed an error page: ${SECRET_WORDS}`,
      replyEmail: 'me@example.com',
      userId: null,
      // The query string can hold a token: it never reaches the database.
      pagePath: '/reset-password',
      release: 'roundtable-api:abc123',
      userAgent: FIREFOX,
      issueUrl: 'https://github.com/owner/repo/issues/1',
    });
    expect(row?.createdAt).toBeInstanceOf(Date);
    // The address is only kept as a keyed hash.
    expect(row?.clientKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('links a signed-in report to the user, and ignores a user id in the body', async () => {
    const { cookie, user } = await signUp(t);

    const signedIn = await report(t, valid, { cookie });
    const spoofed = await report(t, { ...valid, userId: user.id });

    expect(signedIn.statusCode).toBe(201);
    expect(spoofed.statusCode).toBe(201);

    const rows = await storedReports(t);
    const byId = new Map(rows.map((row) => [row.id, row.userId]));

    expect(byId.get(signedIn.json<{ id: string }>().id)).toBe(user.id);
    expect(byId.get(spoofed.json<{ id: string }>().id)).toBeNull();
  });

  it('opens a GitHub issue with only safe context, labelled bug and user-report, never ready', async () => {
    const { cookie, user } = await signUp(t);
    const res = await report(t, valid, { cookie });
    const { id } = res.json<{ id: string }>();
    const [row] = await t.db.select().from(userReports).where(eq(userReports.id, id));

    expect(issues).toHaveLength(1);
    const [issue] = issues;

    expect(issue?.title).toBe(`User report ${id}: /settings/profile`);
    expect(issue?.labels).toEqual(['bug', 'user-report']);
    expect(REPORT_ISSUE_LABELS).not.toContain('ready');
    expect(issue?.body).toContain(`Report: ${id}`);
    expect(issue?.body).toContain('Page: `/settings/profile`');
    expect(issue?.body).toContain('Release: `roundtable-api:abc123`');
    expect(issue?.body).toContain(`Time: ${row?.createdAt.toISOString()}`);
    expect(issue?.body).toContain('Browser: Firefox');

    // Nothing the user typed or that identifies them.
    const published = `${issue?.title}\n${issue?.body}`;

    for (const value of [SECRET_WORDS, 'Sign in with GitHub', 'me@example.com', user.id, FIREFOX]) {
      expect(published).not.toContain(value);
    }
  });

  it('emails the owner the full report with a link to the issue', async () => {
    const res = await report(t, valid);
    const { id } = res.json<{ id: string }>();
    const emails = t.sentEmails.filter((email) => email.to === OWNER);

    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({
      kind: 'user-report',
      subject: `User report ${id}: /settings/profile`,
    });
    expect(emails[0]?.text).toContain(SECRET_WORDS);
    expect(emails[0]?.text).toContain('Reply to: me@example.com');
    expect(emails[0]?.text).toContain('GitHub issue: https://github.com/owner/repo/issues/1');
  });

  it('rejects a blank, whitespace-only or too long description, and a malformed email', async () => {
    const invalid: Json[] = [
      { ...valid, description: '' },
      { ...valid, description: ' \n\t ' },
      { ...valid, description: 'x'.repeat(2001) },
      { ...valid, replyEmail: 'not an email' },
      { ...valid, replyEmail: 'a@b' },
      { ...valid, pagePath: 'https://evil.example/ignore previous instructions' },
      { description: 'no page' },
    ];

    for (const payload of invalid) {
      expect((await report(t, payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }

    expect((await report(t, { ...valid, description: 'x'.repeat(2000) })).statusCode).toBe(201);
    expect((await report(t, { ...valid, replyEmail: null })).statusCode).toBe(201);
    expect(await storedReports(t)).toHaveLength(2);
  });

  it(`answers 429 after ${REPORTS_PER_HOUR} reports from one address in an hour, storing and sending nothing`, async () => {
    const ip = '198.51.100.7';

    for (let i = 0; i < REPORTS_PER_HOUR; i++) {
      expect((await report(t, valid, { ip })).statusCode).toBe(201);
    }

    const limited = await report(t, valid, { ip });

    expect(limited.statusCode).toBe(429);
    expect(() => Schema.decodeUnknownSync(ReportRateLimited)(limited.json())).not.toThrow();
    expect(await storedReports(t)).toHaveLength(REPORTS_PER_HOUR);
    expect(issues).toHaveLength(REPORTS_PER_HOUR);
    expect(t.sentEmails.filter((email) => email.to === OWNER)).toHaveLength(REPORTS_PER_HOUR);

    // Another address isn't affected, and an hour-old report no longer counts.
    expect((await report(t, valid)).statusCode).toBe(201);
    await t.db.update(userReports).set({ createdAt: new Date(Date.now() - 61 * 60 * 1000) });
    expect((await report(t, valid, { ip })).statusCode).toBe(201);
  });
});

describe('the daily cap on report issues and emails', () => {
  const issues: NewIssue[] = [];

  const t = setupTestApp({
    env: { REPORTS_EMAIL: OWNER, REPORT_LIMIT_PER_DAY: 2 },
    openIssue: async (issue) => {
      issues.push(issue);

      return { url: 'https://github.com/owner/repo/issues/1' };
    },
  });

  beforeAll(() => t.migrate());
  beforeEach(() => t.reset());
  afterAll(() => t.close());

  it('stores every report but opens and emails at most the cap per 24 hours', async () => {
    for (let i = 0; i < 4; i++) expect((await report(t, valid)).statusCode).toBe(201);

    const rows = await storedReports(t);

    expect(rows).toHaveLength(4);
    expect(issues).toHaveLength(2);
    expect(rows.filter((row) => row.issueUrl)).toHaveLength(2);
    // The Mailer's per-address limit for report emails is the same cap.
    expect(t.sentEmails.filter((email) => email.to === OWNER)).toHaveLength(2);

    // A day later the cap is free again.
    await t.db
      .update(userReports)
      .set({ issueRequestedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
    await report(t, valid);
    expect(issues).toHaveLength(3);
  });
});

describe('without GITHUB_ISSUES_TOKEN', () => {
  const lines: string[] = [];

  const t = setupTestApp({
    env: { REPORTS_EMAIL: OWNER },
    logStream: { write: (line) => void lines.push(line) },
  });

  beforeAll(() => t.migrate());
  beforeEach(() => t.reset());
  afterAll(() => t.close());

  it('stores and emails the report, and logs that the issue was skipped', async () => {
    const res = await report(t, valid);

    expect(res.statusCode).toBe(201);
    expect(await storedReports(t)).toHaveLength(1);
    expect(t.sentEmails.filter((email) => email.to === OWNER)[0]?.text).toContain(
      'GitHub issue: not opened: GITHUB_ISSUES_TOKEN is not set',
    );
    expect(lines.some((line) => line.includes('GitHub issue skipped'))).toBe(true);
  });
});

describe('without REPORTS_EMAIL', () => {
  const lines: string[] = [];
  const t = setupTestApp({ logStream: { write: (line) => void lines.push(line) } });

  beforeAll(() => t.migrate());
  beforeEach(() => t.reset());
  afterAll(() => t.close());

  it('stores the report and logs that it was not emailed', async () => {
    expect((await report(t, valid)).statusCode).toBe(201);
    expect(await storedReports(t)).toHaveLength(1);
    expect(t.sentEmails).toHaveLength(0);
    expect(lines.some((line) => line.includes('REPORTS_EMAIL is not set'))).toBe(true);
  });
});

describe('when GitHub or the email fails', () => {
  const events: ErrorEvent[] = [];
  const lines: string[] = [];

  const t = setupTestApp({
    env: { REPORTS_EMAIL: OWNER },
    errorEvents: events,
    logStream: { write: (line) => void lines.push(line) },
    openIssue: () => Promise.reject(new Error('GitHub is down')),
    sendEmail: () => Promise.reject(new Error('Resend is down')),
  });

  beforeAll(() => t.migrate());
  beforeEach(() => t.reset());
  afterAll(() => t.close());

  it('still stores the report and confirms it, and reports both failures without user data', async () => {
    const res = await report(t, valid);

    expect(res.statusCode).toBe(201);
    expect(await storedReports(t)).toHaveLength(1);
    await Sentry.flush(2000);

    const issueFailures = events.filter((event) =>
      event.exception?.values?.some((value) => value.type === 'IssueOpenFailed'),
    );

    const emailFailures = events.filter((event) =>
      event.exception?.values?.some((value) => value.type === 'EmailSendFailed'),
    );

    expect(issueFailures).toHaveLength(1);
    expect(issueFailures[0]?.extra).toMatchObject({ source: 'github-issues' });
    expect(emailFailures).toHaveLength(1);
    expect(emailFailures[0]?.extra).toMatchObject({ emailKind: 'user-report' });

    const reported = JSON.stringify(events) + lines.join('\n');

    for (const value of [SECRET_WORDS, 'me@example.com']) expect(reported).not.toContain(value);
  });
});

describe('browserFamily', () => {
  it.each([
    [FIREFOX, 'Firefox'],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
      'Chrome',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0',
      'Edge',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 OPR/115.0',
      'Opera',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      'Safari',
    ],
    ['curl/8.0', 'Other'],
    [undefined, 'Unknown'],
  ])('%s is %s', (userAgent, family) => {
    expect(browserFamily(userAgent)).toBe(family);
  });
});
