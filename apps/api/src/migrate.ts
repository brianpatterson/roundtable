import { runMigrateCommand } from './platform/database/migrate-command.js';
import { loadEnv } from './platform/config/env.js';

// Runs as its own container in each deploy (ADR-0014), with the API's environment, read and
// validated the same way the server reads it. `pre` runs before the new release starts, `post`
// after it's healthy, and no argument runs everything (ADR-0073). A failure is reported by
// runMigrateCommand rather than left to Node, which would print the whole error, Postgres's
// `detail` and its row values included, into the public deploy log (#275).
const result = await runMigrateCommand(process.argv.slice(2), loadEnv().DATABASE_URL);

(result.code === 0 ? console.log : console.error)(result.output);

process.exitCode = result.code;
