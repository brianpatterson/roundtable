import { Layer } from 'effect';
import type { Env } from '../../platform/config/env.js';
import type { Log } from '../../platform/observability/logging.js';
import { GitHubIssues, gitHubIssuesLayer } from './github.js';
import { SupportApiLive } from './handlers.js';

export interface SupportOptions {
  /** Tests: replaces the GitHub client chosen from the environment (GitHub or skipped). */
  readonly githubIssues?: Layer.Layer<GitHubIssues> | undefined;
}

/** GitHub when a token is set, otherwise a log line per report saying the issue was skipped. */
function issuesFromEnv(env: Env, log: Pick<Log, 'info'>) {
  return env.GITHUB_ISSUES_TOKEN && env.GITHUB_ISSUES_REPOSITORY
    ? gitHubIssuesLayer({
        token: env.GITHUB_ISSUES_TOKEN,
        repository: env.GITHUB_ISSUES_REPOSITORY,
      })
    : GitHubIssues.skipped(log);
}

/**
 * Everything support gives the App, provided once: the report endpoint, with its GitHub client
 * chosen inside. The App provides the Database, the Mailer and the OptionalSession middleware.
 */
export const SupportLive = (env: Env, log: Pick<Log, 'info'>, options: SupportOptions = {}) =>
  SupportApiLive(env).pipe(Layer.provide(options.githubIssues ?? issuesFromEnv(env, log)));
