import { Layer } from 'effect';
import type { Env } from '../../platform/config/env.js';
import type { Log } from '../../platform/observability/logging.js';
import { FactoryReportsApiLive } from './factory-reports.js';
import { GitHubIssues, gitHubIssuesLayer } from './github.js';
import { SupportApiLive } from './handlers.js';

export interface SupportOptions {
  /** Tests: replaces the GitHub client chosen from the environment (GitHub or skipped). */
  readonly githubIssues?: Layer.Layer<GitHubIssues> | undefined;
}

/** GitHub when its App is set, otherwise a log line per report saying the issue was skipped. */
function issuesFromEnv(env: Env, log: Pick<Log, 'info'>) {
  const {
    GITHUB_ISSUES_APP_ID: appId,
    GITHUB_ISSUES_INSTALLATION_ID: installationId,
    GITHUB_ISSUES_PRIVATE_KEY: privateKey,
    GITHUB_ISSUES_REPOSITORY: repository,
  } = env;

  return appId && installationId && privateKey && repository
    ? gitHubIssuesLayer({ appId, installationId, privateKey, repository })
    : GitHubIssues.skipped(log);
}

/**
 * Everything support gives the App, provided once: the report endpoint, with its GitHub client
 * chosen inside, and the factory's read endpoint (ADR-0041). The App provides the Database, the
 * Mailer and the OptionalSession middleware.
 */
export const SupportLive = (env: Env, log: Pick<Log, 'info'>, options: SupportOptions = {}) =>
  Layer.mergeAll(
    SupportApiLive(env).pipe(Layer.provide(options.githubIssues ?? issuesFromEnv(env, log))),
    FactoryReportsApiLive(env),
  );
