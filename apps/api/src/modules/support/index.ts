// The support module's public interface (ADR-0023): server.ts imports from here, never from the
// files behind it. "Report a problem" (ADR-0038): stores reports, opens a GitHub issue with safe
// context only, and emails the owner the full report. The App provides SupportLive once.
export { GitHubIssues, type NewIssue, type OpenedIssue } from './github.js';

export { userReports } from './schema.js';

export { SupportLive } from './support.js';
