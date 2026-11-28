// The Conductor's command line (README.md):
//
//   GITHUB_REPOSITORY=<owner>/<name> GH_TOKEN=… node tools/conductor/main.ts run [--dry-run]
//   GITHUB_REPOSITORY=<owner>/<name> GH_TOKEN=… node tools/conductor/main.ts why <n>
//   GITHUB_REPOSITORY=<owner>/<name> GH_TOKEN=$(gh auth token) node tools/conductor/main.ts record 291 288
//
// The time is read once, at the start of a command, and passed on: nothing else reads the clock.

import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { type Surface, type Write, act, plan, readSurface } from './act.ts';
import { type Decision, decide } from './decide.ts';
import { fixtureOf, serialize } from './fixture.ts';
import { type GitHub, gather, gatherWorkItem } from './gather.ts';
import { observe } from './observe.ts';
import { policy } from './policy.ts';
import type { GatheredOpenWorkItem } from './raw.ts';
import type { Fact, WorkItemState } from './state.ts';
import { why } from './why.ts';

export interface Io {
  readonly fetch: typeof fetch;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The time now: read once, at the start of a command. */
  readonly now: () => Date;
  /** Writes a history fixture's text as `<number>.json`. */
  readonly save: (number: number, text: string) => Promise<void>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const USAGE = [
  'Usage: node tools/conductor/main.ts run [--dry-run]',
  '       node tools/conductor/main.ts why <number>',
  '       node tools/conductor/main.ts record <number>…',
].join('\n');

const DAY = 24 * 60 * 60 * 1000;

const isNumber = (text: string): boolean => /^[1-9][0-9]*$/.test(text);

/** The token and repository from the environment, or `null` after saying what's missing. */
function github(io: Io): GitHub | null {
  const token = io.env.GH_TOKEN ?? '';
  const repository = io.env.GITHUB_REPOSITORY ?? '';

  if (token === '' || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    io.err('Set GH_TOKEN to a GitHub token and GITHUB_REPOSITORY to <owner>/<name>.');

    return null;
  }

  return { fetch: io.fetch, token, repository };
}

async function record(numbers: readonly string[], io: Io): Promise<number> {
  const gh = github(io);

  if (gh === null) return 2;

  if (numbers.length === 0 || !numbers.every(isNumber)) {
    io.err(USAGE);

    return 2;
  }

  let failed = 0;

  for (const number of numbers.map(Number)) {
    const gathered = await gatherWorkItem(gh, number);

    if ('unreadable' in gathered) {
      io.err(`#${number}: not recorded: ${gathered.unreadable}`);
      failed = 1;
      continue;
    }

    try {
      const fixture = fixtureOf(gathered);

      await io.save(number, serialize(fixture));
      io.out(`#${number}: recorded, ${fixture.checkpoints.length} checkpoints`);
    } catch (error) {
      io.err(`#${number}: not recorded: ${error instanceof Error ? error.message : String(error)}`);
      failed = 1;
    }
  }

  return failed;
}

/** One Work item's state, decision and the writes that carry it out. */
interface Decided {
  readonly item: GatheredOpenWorkItem;
  readonly state: WorkItemState;
  readonly decision: Decision;
  readonly writes: readonly Write[];
}

/** Gathers every open Work item, observes each at `at`, decides, and plans each one's writes. */
async function conduct(gh: GitHub, at: Date): Promise<Decided[]> {
  const gathered = await gather(gh, {
    since: new Date(at.getTime() - DAY),
    until: null,
    commits: 'head',
  });

  const states = gathered.map((item): WorkItemState => {
    if (!('unreadable' in item)) return observe(item, at);

    // A Work item that couldn't be read is decided on what's missing: it waits, and holds the slot.
    const missing: Fact<never> = { known: false, missing: item.unreadable };

    return {
      number: item.number,
      at: at.toISOString(),
      ticket: missing,
      pullRequest: missing,
      runs: missing,
      main: missing,
    };
  });

  const decisions = decide(states, policy);

  return gathered.map((item, index) => {
    const state = states[index];
    const decision = decisions[index];

    if (state === undefined || decision === undefined)
      throw new Error(`decide returned no decision for #${item.number}`);

    // Nothing is written for a Work item that couldn't be read: where to write isn't known.
    if ('unreadable' in item) return { item, state, decision, writes: [] };

    let surface: Surface;

    try {
      surface = readSurface(item.surface);
    } catch (error) {
      const refused: Write = {
        item: item.number,
        what: 'carry out its decision',
        request: {
          refused: `what it would write over couldn't be read: ${error instanceof Error ? error.message : String(error)}`,
        },
        undo: null,
      };

      return { item, state, decision, writes: [refused] };
    }

    return {
      item,
      state,
      decision,
      writes: plan({ decision, state, surface, repository: gh.repository, at: at.toISOString() }),
    };
  });
}

async function run(args: readonly string[], io: Io): Promise<number> {
  const dryRun = args.includes('--dry-run');

  if (args.some((arg) => arg !== '--dry-run')) {
    io.err(USAGE);

    return 2;
  }

  // Before reading anything.
  const gh = github(io);

  if (gh === null) return 1;

  const at = io.now();
  let decided: Decided[];

  try {
    decided = await conduct(gh, at);
  } catch (error) {
    io.err(
      `Nothing was read in full, so nothing was written: ${error instanceof Error ? error.message : String(error)}`,
    );

    return 1;
  }

  for (const { item, decision } of decided) {
    if ('unreadable' in item) io.err(`#${item.number}: couldn't be read: ${item.unreadable}`);

    io.out(`#${decision.number}: ${decision.state}: ${decision.reason}`);
  }

  const failed = await act(
    gh,
    decided.flatMap((entry) => entry.writes),
    { dryRun, out: (line) => io.out(dryRun ? `Would write ${line}` : `Write ${line}`) },
  );

  for (const line of failed) io.err(`Failed: ${line}`);

  return failed.length === 0 ? 0 : 1;
}

async function explain(args: readonly string[], io: Io): Promise<number> {
  const [number, ...extra] = args;

  if (number === undefined || !isNumber(number) || extra.length > 0) {
    io.err(USAGE);

    return 2;
  }

  const gh = github(io);

  if (gh === null) return 1;

  const at = io.now();
  let decided: Decided[];

  try {
    decided = await conduct(gh, at);
  } catch (error) {
    io.err(
      `The open Work items couldn't be read: ${error instanceof Error ? error.message : String(error)}`,
    );

    return 1;
  }

  // The Work item by its number, or by its pull request's.
  const found = decided.find(
    (entry) =>
      entry.decision.number === Number(number) ||
      (entry.state.pullRequest.known && entry.state.pullRequest.value?.number === Number(number)),
  );

  if (found === undefined) {
    io.err(
      `#${number} isn't an open Work item: an open issue labeled ready, building, needs-info or needs-human, or an open pull request labeled factory or autofix or opened by Dependabot.`,
    );

    return 1;
  }

  if ('unreadable' in found.item) io.out(`Couldn't be read: ${found.item.unreadable}`);

  for (const line of why(found.decision, found.state, policy)) io.out(line);

  io.out(found.writes.length === 0 ? 'Writes `run` would make: none' : 'Writes `run` would make:');

  for (const write of found.writes) io.out(`  ${write.what}`);

  return 0;
}

/** Runs one command; returns the exit code. */
export async function main(args: readonly string[], io: Io): Promise<number> {
  const [command, ...rest] = args;

  if (command === 'run') return run(rest, io);

  if (command === 'why') return explain(rest, io);

  if (command === 'record') return record(rest, io);

  io.err(USAGE);

  return 2;
}

const history = new URL('history/', import.meta.url);

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2), {
    fetch,
    env: process.env,
    now: () => new Date(),
    save: async (number, text) => {
      await mkdir(history, { recursive: true });
      await writeFile(new URL(`${number}.json`, history), text);
    },
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}
