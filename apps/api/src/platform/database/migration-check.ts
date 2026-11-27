import { Redacted } from 'effect';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { isPostDeploy, runMigrations } from './migrate.js';
import { createDb } from './promise.js';

// The migration check (ADR-0073): every migration added since `origin/main` is judged against the
// schema `main` builds, the one the previous release runs on. It enforces only what it lists.

const run = promisify(execFile);

/** A schema change the check knows about, read from one statement of a migration. */
export type Change =
  | { readonly kind: 'create-table'; readonly table: string }
  | { readonly kind: 'create-type'; readonly type: string }
  | { readonly kind: 'rename-table'; readonly table: string }
  | { readonly kind: 'rename-column'; readonly table: string; readonly column: string }
  | { readonly kind: 'drop-table'; readonly table: string }
  | { readonly kind: 'drop-column'; readonly table: string; readonly column: string }
  | { readonly kind: 'drop-type'; readonly type: string }
  | { readonly kind: 'set-not-null'; readonly table: string; readonly column: string }
  | { readonly kind: 'set-data-type'; readonly table: string; readonly column: string }
  | {
      readonly kind: 'add-column';
      readonly table: string;
      readonly column: string;
      /** `NOT NULL` without a `DEFAULT`: rows inserted without it fail. */
      readonly notNullWithoutDefault: boolean;
    }
  | { readonly kind: 'add-constraint'; readonly table: string; readonly constraint: string }
  | { readonly kind: 'create-unique-index'; readonly table: string };

/** One statement of a migration and the changes the check recognizes in it (often none). */
export interface Statement {
  readonly sql: string;
  readonly changes: readonly Change[];
}

/**
 * Splits a `migration.sql` into its statements (drizzle-kit separates them with
 * `--> statement-breakpoint`), without comment lines or the trailing semicolon, and classifies
 * each. A statement it doesn't recognize has no changes.
 */
export function classifyMigration(sql: string): Statement[] {
  return sql
    .split('--> statement-breakpoint')
    .map((part) =>
      part
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim()
        .replace(/;\s*$/, '')
        .trim(),
    )
    .filter((statement) => statement !== '')
    .map((statement) => ({ sql: statement, changes: classifyStatement(statement) }));
}

// An identifier, quoted or not, optionally schema-qualified: the last part is captured.
const identifier = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const qualified = String.raw`(?:${identifier}\s*\.\s*)?(${identifier})`;

function pattern(source: string) {
  return new RegExp(`^${source}`, 'i');
}

const createTable = pattern(
  String.raw`CREATE\s+(?:(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP|TEMPORARY|UNLOGGED)\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${qualified}`,
);

const createType = pattern(String.raw`CREATE\s+TYPE\s+${qualified}`);
const dropTable = pattern(String.raw`DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(.+)$`);
const dropType = pattern(String.raw`DROP\s+TYPE\s+(?:IF\s+EXISTS\s+)?(.+)$`);

const createUniqueIndex = pattern(
  String.raw`CREATE\s+UNIQUE\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:(?:IF\s+NOT\s+EXISTS\s+)?${identifier}\s+)?ON\s+(?:ONLY\s+)?${qualified}`,
);

const alterTable = pattern(
  String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${qualified}\s*\*?\s+([\s\S]+)$`,
);

const renameTo = pattern(String.raw`RENAME\s+TO\s+`);
const renameConstraint = pattern(String.raw`RENAME\s+CONSTRAINT\b`);
const renameColumn = pattern(String.raw`RENAME\s+(?:COLUMN\s+)?(${identifier})\s+TO\s+`);
const dropConstraint = pattern(String.raw`DROP\s+CONSTRAINT\b`);
const dropColumn = pattern(String.raw`DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?(${identifier})`);
const setNotNull = pattern(String.raw`ALTER\s+(?:COLUMN\s+)?(${identifier})\s+SET\s+NOT\s+NULL\b`);

const setDataType = pattern(
  String.raw`ALTER\s+(?:COLUMN\s+)?(${identifier})\s+(?:SET\s+DATA\s+)?TYPE\s`,
);

const addConstraint = pattern(String.raw`ADD\s+(?:CONSTRAINT\s+${identifier}\s+)?(UNIQUE|CHECK)\b`);

const addOther = pattern(String.raw`ADD\s+(?:CONSTRAINT|PRIMARY|FOREIGN|EXCLUDE|UNIQUE|CHECK)\b`);

const addColumn = pattern(
  String.raw`ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${identifier})\s+([\s\S]*)$`,
);

const notNull = /\bNOT\s+NULL\b/i;

// A default, or a type or clause that brings its own.
const hasDefault =
  /\b(?:DEFAULT|GENERATED|SMALLSERIAL|SERIAL|BIGSERIAL|SERIAL2|SERIAL4|SERIAL8)\b/i;

/** The pattern's first two captures (empty when it has fewer), or `undefined` without a match. */
function captures(re: RegExp, text: string): readonly [string, string] | undefined {
  const match = re.exec(text);

  return match ? [match[1] ?? '', match[2] ?? ''] : undefined;
}

/** The changes in one statement that the check knows; anything else is none. */
function classifyStatement(statement: string): Change[] {
  const sql = statement.replace(/\s+/g, ' ');

  const table = captures(createTable, sql);

  if (table) return [{ kind: 'create-table', table: name(table[0]) }];

  const type = captures(createType, sql);

  if (type) return [{ kind: 'create-type', type: name(type[0]) }];

  const droppedTables = captures(dropTable, sql);

  if (droppedTables)
    return names(droppedTables[0]).map((dropped) => ({ kind: 'drop-table', table: dropped }));

  const droppedTypes = captures(dropType, sql);

  if (droppedTypes)
    return names(droppedTypes[0]).map((dropped) => ({ kind: 'drop-type', type: dropped }));

  const index = captures(createUniqueIndex, sql);

  if (index) return [{ kind: 'create-unique-index', table: name(index[0]) }];

  const altered = captures(alterTable, sql);

  if (altered) return alterTableChanges(name(altered[0]), altered[1]);

  return [];
}

function alterTableChanges(table: string, actions: string): Change[] {
  if (renameTo.test(actions)) return [{ kind: 'rename-table', table }];

  if (renameConstraint.test(actions)) return [];

  const renamed = captures(renameColumn, actions);

  if (renamed) return [{ kind: 'rename-column', table, column: name(renamed[0]) }];

  return topLevel(actions, ',').flatMap((action) => alterTableAction(table, action.trim()));
}

function alterTableAction(table: string, action: string): Change[] {
  if (dropConstraint.test(action)) return [];

  const dropped = captures(dropColumn, action);

  if (dropped) return [{ kind: 'drop-column', table, column: name(dropped[0]) }];

  const required = captures(setNotNull, action);

  if (required) return [{ kind: 'set-not-null', table, column: name(required[0]) }];

  const retyped = captures(setDataType, action);

  if (retyped) return [{ kind: 'set-data-type', table, column: name(retyped[0]) }];

  const constraint = captures(addConstraint, action);

  if (constraint)
    return [{ kind: 'add-constraint', table, constraint: constraint[0].toUpperCase() }];

  if (addOther.test(action)) return [];

  const added = captures(addColumn, action);

  if (added) {
    const [column, definition] = added;

    return [
      {
        kind: 'add-column',
        table,
        column: name(column),
        notNullWithoutDefault: notNull.test(definition) && !hasDefault.test(definition),
      },
    ];
  }

  return [];
}

/** `"public"."Rounds"` → `Rounds`, `Rounds` → `rounds`: how Postgres resolves the name. */
function name(raw: string) {
  const last = topLevel(raw.trim(), '.').at(-1)?.trim() ?? raw;

  return last.startsWith('"') ? last.slice(1, -1).replaceAll('""', '"') : last.toLowerCase();
}

/** The names in a `DROP` list, without its `CASCADE` or `RESTRICT`. */
function names(list: string) {
  return topLevel(list.replace(/\s+(?:CASCADE|RESTRICT)\s*$/i, ''), ',').map(name);
}

/** Splits on `separator` where it isn't inside parentheses, quotes or a quoted identifier. */
function topLevel(text: string, separator: string) {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"') quote = char;
    else if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }

  parts.push(text.slice(start));

  return parts;
}

/** What exists on `main`: the tables, `table.column`s and enum types in `public`. */
export interface Schema {
  readonly tables: ReadonlySet<string>;
  readonly columns: ReadonlySet<string>;
  readonly types: ReadonlySet<string>;
}

/** A migration folder's name and its `migration.sql`. */
export interface Migration {
  readonly name: string;
  readonly sql: string;
}

/** A statement in a new migration that the previous release's code can't live with. */
export interface Problem {
  readonly migration: string;
  readonly statement: string;
  readonly reason: string;
}

const moveIt = 'Move it into a _postdeploy migration (pnpm db:generate --name <what>_postdeploy).';

const threeSteps =
  "Neither phase is safe for a rename: do it in ADR-0073's three steps (add the new one and copy " +
  'the data pre-deploy, switch the code to it, drop the old one post-deploy).';

/** Every problem in the new migrations, judged against the schema `main` builds (ADR-0073). */
export function judgeMigrations(migrations: readonly Migration[], main: Schema): Problem[] {
  return [...migrations]
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((migration) =>
      classifyMigration(migration.sql).flatMap((statement) =>
        statement.changes.flatMap((change) => {
          const reason = judgeChange(change, main, isPostDeploy(migration.name));

          return reason === undefined
            ? []
            : [{ migration: migration.name, statement: statement.sql, reason }];
        }),
      ),
    );
}

function judgeChange(change: Change, main: Schema, postDeploy: boolean): string | undefined {
  const onMain = (table: string, column?: string) =>
    column === undefined ? main.tables.has(table) : main.columns.has(`${table}.${column}`);

  const preDeployOnly = (what: string) =>
    postDeploy ? undefined : `${what}, which the previous release still uses. ${moveIt}`;

  switch (change.kind) {
    case 'rename-table':
      return onMain(change.table)
        ? `Renames table ${change.table}, which exists on main. ${threeSteps}`
        : undefined;
    case 'rename-column':
      return onMain(change.table, change.column)
        ? `Renames column ${change.table}.${change.column}, which exists on main. ${threeSteps}`
        : undefined;
    case 'add-column':
      return change.notNullWithoutDefault && onMain(change.table)
        ? `Adds NOT NULL column ${change.table}.${change.column} without a default to a table ` +
            "that exists on main: the previous release's inserts would fail, in either phase. " +
            'Add it with a DEFAULT, or add it nullable and SET NOT NULL in a _postdeploy migration.'
        : undefined;
    case 'drop-table':
      return onMain(change.table) ? preDeployOnly(`Drops table ${change.table}`) : undefined;
    case 'drop-column':
      return onMain(change.table, change.column)
        ? preDeployOnly(`Drops column ${change.table}.${change.column}`)
        : undefined;
    case 'drop-type':
      return main.types.has(change.type) ? preDeployOnly(`Drops type ${change.type}`) : undefined;
    // The previous release inserts rows without a column it doesn't know, so a NOT NULL is judged
    // by its table, as ADD COLUMN … NOT NULL is.
    case 'set-not-null':
      return onMain(change.table)
        ? preDeployOnly(`Makes ${change.table}.${change.column} NOT NULL on a table`)
        : undefined;
    case 'set-data-type':
      return onMain(change.table, change.column)
        ? preDeployOnly(`Changes the type of ${change.table}.${change.column}`)
        : undefined;
    case 'add-constraint':
      return onMain(change.table)
        ? preDeployOnly(`Adds a ${change.constraint} constraint to table ${change.table}`)
        : undefined;
    case 'create-unique-index':
      return onMain(change.table)
        ? preDeployOnly(`Adds a unique index to table ${change.table}`)
        : undefined;
    case 'create-table':
    case 'create-type':
      return undefined;
  }
}

/** The tables, columns and enum types in `public`, as the check compares them. */
export async function readSchema(pool: pg.Pool): Promise<Schema> {
  const tables = await pool.query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'`,
  );

  const columns = await pool.query<{ table_name: string; column_name: string }>(
    `select table_name, column_name from information_schema.columns
      where table_schema = 'public'`,
  );

  const types = await pool.query<{ typname: string }>(
    `select t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public' and t.typtype = 'e'`,
  );

  return {
    tables: new Set(tables.rows.map((row) => row.table_name)),
    columns: new Set(columns.rows.map((row) => `${row.table_name}.${row.column_name}`)),
    types: new Set(types.rows.map((row) => row.typname)),
  };
}

/** The scratch database's name: `<test database>_migration_check_<pid>`. */
export function scratchDatabaseName(testDatabaseUrl: string) {
  return `${new URL(testDatabaseUrl).pathname.slice(1)}_migration_check_${process.pid}`;
}

/**
 * Creates the scratch database next to the test database, calls `use` with its URL, and drops it
 * afterwards, whether `use` succeeds or not.
 */
export async function withScratchDatabase<A>(
  testDatabaseUrl: string,
  use: (url: string) => Promise<A>,
): Promise<A> {
  const name = scratchDatabaseName(testDatabaseUrl);
  const url = new URL(testDatabaseUrl);
  const admin = new pg.Client({ connectionString: testDatabaseUrl });

  url.pathname = `/${name}`;
  await admin.connect();

  try {
    await admin.query(`drop database if exists ${admin.escapeIdentifier(name)}`);
    await admin.query(`create database ${admin.escapeIdentifier(name)}`);

    try {
      return await use(url.href);
    } finally {
      await admin.query(`drop database if exists ${admin.escapeIdentifier(name)} with (force)`);
    }
  } finally {
    await admin.end();
  }
}

/** Applies the migrations in `folder` to a scratch database and reads the schema they build. */
export async function schemaOf(folder: string, testDatabaseUrl: string): Promise<Schema> {
  return withScratchDatabase(testDatabaseUrl, async (url) => {
    const { db, pool } = createDb(Redacted.make(url), 'roundtable-migration-check');

    try {
      await runMigrations(db, undefined, folder);

      return await readSchema(pool);
    } finally {
      await pool.end();
    }
  });
}

/** Raised when `ref` can't be read: the check can't tell which migrations are new. */
export class UnreadableRef extends Error {
  constructor(readonly ref: string) {
    super(
      `The migration check can't read ${ref}, so it can't tell which migrations are new. ` +
        `Fetch it first: git fetch origin main.`,
    );
  }
}

async function git(cwd: string, args: readonly string[]) {
  const { stdout } = await run('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024 });

  return stdout;
}

/** The migrations in `folder` as `ref` has them (by name, with their SQL). */
export async function migrationsAt(folder: string, ref: string): Promise<Migration[]> {
  const real = await realpath(folder);

  try {
    await git(real, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch {
    throw new UnreadableRef(ref);
  }

  const root = (await git(real, ['rev-parse', '--show-toplevel'])).trim();
  const path = relative(await realpath(root), real);
  let listing: string;

  try {
    listing = await git(root, ['ls-tree', '-d', '--name-only', `${ref}:${path}`]);
  } catch {
    // The folder doesn't exist on `ref` yet: every migration is new.
    return [];
  }

  const names = listing.split('\n').filter((entry) => entry !== '');

  return Promise.all(
    names.map(async (entry) => ({
      name: entry,
      sql: await git(root, ['show', `${ref}:${path}/${entry}/migration.sql`]),
    })),
  );
}

/** The migrations in `folder` on disk, committed or not. */
export async function migrationsIn(folder: string): Promise<Migration[]> {
  const entries = await readdir(folder, { withFileTypes: true });

  return Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => ({
        name: entry.name,
        sql: await readFile(join(folder, entry.name, 'migration.sql'), 'utf8'),
      })),
  );
}

/** Writes migrations to a fresh temporary folder, calls `use` with it, and removes it after. */
async function withMigrationsFolder<A>(
  migrations: readonly Migration[],
  use: (folder: string) => Promise<A>,
): Promise<A> {
  const folder = await mkdtemp(join(tmpdir(), 'roundtable-migration-check-'));

  try {
    for (const migration of migrations) {
      await mkdir(join(folder, migration.name));
      await writeFile(join(folder, migration.name, 'migration.sql'), migration.sql);
    }

    return await use(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

export interface CheckResult {
  /** The process's exit code: 1 when any new migration has a problem. */
  readonly code: 0 | 1;
  readonly output: string;
}

/**
 * The whole check: the migrations in `folder` that `ref` doesn't have are new, and each is judged
 * against the schema `ref`'s migrations build in a scratch database next to `testDatabaseUrl`.
 */
export async function checkMigrations(options: {
  readonly folder: string;
  readonly ref: string;
  readonly testDatabaseUrl: string;
}): Promise<CheckResult> {
  const merged = await migrationsAt(options.folder, options.ref);
  const mergedNames = new Set(merged.map((migration) => migration.name));

  const added = (await migrationsIn(options.folder)).filter(
    (migration) => !mergedNames.has(migration.name),
  );

  if (added.length === 0)
    return { code: 0, output: `Migration check: no new migrations since ${options.ref}.` };

  const main = await withMigrationsFolder(merged, (folder) =>
    schemaOf(folder, options.testDatabaseUrl),
  );

  return report(added, judgeMigrations(added, main));
}

/** Each problem by migration folder, statement and fix. */
export function report(added: readonly Migration[], problems: readonly Problem[]): CheckResult {
  const judged = `${added.length} new migration${added.length === 1 ? '' : 's'}`;

  if (problems.length === 0)
    return {
      code: 0,
      output: `Migration check: ${judged}, nothing the previous release can't live with.`,
    };

  const lines = problems.flatMap((problem) => [
    '',
    `${problem.migration}:`,
    `  ${problem.statement.replace(/\s+/g, ' ')}`,
    `  ${problem.reason}`,
  ]);

  return {
    code: 1,
    output: [
      `Migration check (ADR-0073): ${problems.length} problem${problems.length === 1 ? '' : 's'} in ${judged}.`,
      ...lines,
    ].join('\n'),
  };
}
