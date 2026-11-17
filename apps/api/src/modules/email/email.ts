import { Layer } from 'effect';
import type { Env } from '../../platform/config/env.js';
import type { Log } from '../../platform/observability/logging.js';
import { Mailer } from './mailer.js';
import { EmailTransport, resendLayer } from './transport.js';

export interface EmailOptions {
  /** Tests: replaces the transport chosen from the environment (Resend or the log). */
  readonly transport?: Layer.Layer<EmailTransport> | undefined;
}

/** Resend when it's configured (always in production; see env.ts), otherwise the log. */
function transportFromEnv(env: Env, log: Pick<Log, 'info'>) {
  return env.RESEND_API_KEY && env.EMAIL_FROM
    ? resendLayer({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM })
    : EmailTransport.log(log);
}

/**
 * Everything email gives the App, provided once: the Mailer, with its sending limits read from
 * the environment (ADR-0018) and its transport chosen there too. The App provides the Database,
 * since it owns the pool and email shares it. If email ever becomes its own service, this layer
 * is what gets swapped for one that asks it over the network.
 */
export const EmailLive = (env: Env, log: Pick<Log, 'info'>, options: EmailOptions = {}) =>
  Mailer.layer({
    perAddress: env.EMAIL_LIMIT_PER_ADDRESS,
    perDay: env.EMAIL_LIMIT_PER_DAY,
  }).pipe(Layer.provide(options.transport ?? transportFromEnv(env, log)));
