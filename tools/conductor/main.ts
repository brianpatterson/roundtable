// The Conductor's command line (README.md). `record <n>…` saves Work items as history fixtures.
//
//   GITHUB_REPOSITORY=<owner>/<name> GH_TOKEN=$(gh auth token) node tools/conductor/main.ts record 291 288

import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { fixtureOf, serialize } from './fixture.ts';
import { gatherWorkItem } from './gather.ts';

export interface Io {
  readonly fetch: typeof fetch;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Writes a history fixture's text as `<number>.json`. */
  readonly save: (number: number, text: string) => Promise<void>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const USAGE = 'Usage: node tools/conductor/main.ts record <number>…';

async function record(numbers: readonly string[], io: Io): Promise<number> {
  const token = io.env.GH_TOKEN ?? '';
  const repository = io.env.GITHUB_REPOSITORY ?? '';

  if (token === '' || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    io.err('Set GH_TOKEN to a GitHub token and GITHUB_REPOSITORY to <owner>/<name>.');

    return 2;
  }

  if (numbers.length === 0 || numbers.some((number) => !/^[1-9][0-9]*$/.test(number))) {
    io.err(USAGE);

    return 2;
  }

  const github = { fetch: io.fetch, token, repository };
  let failed = 0;

  for (const number of numbers.map(Number)) {
    const gathered = await gatherWorkItem(github, number);

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

/** Runs one command; returns the exit code. */
export async function main(args: readonly string[], io: Io): Promise<number> {
  const [command, ...rest] = args;

  if (command === 'record') return record(rest, io);

  io.err(USAGE);

  return 2;
}

const history = new URL('history/', import.meta.url);

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2), {
    fetch,
    env: process.env,
    save: async (number, text) => {
      await mkdir(history, { recursive: true });
      await writeFile(new URL(`${number}.json`, history), text);
    },
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}
