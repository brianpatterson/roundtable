import { NodeRuntime } from '@effect/platform-node';
import { Layer } from 'effect';
import { serveApp } from './server.js';
import { loadEnv } from './platform/config/env.js';
import { createLogger } from './platform/observability/logging.js';

const env = loadEnv();

// Docker sends SIGTERM on stop and deploy: runMain interrupts the server, which stops accepting
// connections, lets in-flight requests finish, then closes the pools and flushes Sentry.
Layer.launch(serveApp({ env, log: createLogger(), port: env.API_PORT })).pipe(NodeRuntime.runMain);
