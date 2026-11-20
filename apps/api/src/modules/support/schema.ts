import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Problem reports from "Report a problem" (ADR-0038). The description and reply email are the
 * user's own words and address: private, emailed to the owner, never put in a GitHub issue.
 *
 * `user_id` has no foreign key: modules query only their own tables (ADR-0023), and a report
 * should outlive the account that sent it.
 */
export const userReports = pgTable(
  'user_reports',
  {
    id: uuid().primaryKey().defaultRandom(),
    description: text().notNull(),
    replyEmail: text('reply_email'),
    /** The signed-in user who sent it, if any. */
    userId: text('user_id'),
    /** Without the query string or hash. */
    pagePath: text('page_path').notNull(),
    /** The API build that took it (SENTRY_RELEASE: the deployed image). */
    release: text().notNull(),
    userAgent: text('user_agent'),
    /**
     * HMAC of the client's IP address, keyed with the server's secret: counts reports per address
     * for the hourly limit without storing the address itself.
     */
    clientKey: text('client_key').notNull(),
    /** When this report claimed one of the day's GitHub issues; null if it didn't. */
    issueRequestedAt: timestamp('issue_requested_at', { withTimezone: true }),
    issueUrl: text('issue_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('user_reports_client_key_created_at_idx').on(t.clientKey, t.createdAt),
    index('user_reports_issue_requested_at_idx').on(t.issueRequestedAt),
  ],
);
