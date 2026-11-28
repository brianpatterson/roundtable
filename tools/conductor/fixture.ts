// A history fixture (ADR-0075): what `gather` read about one Work item, the `gather` version that
// read it, and its checkpoints (`record.ts`). Written byte for byte the same from the same answers,
// so a re-recording shows only what changed, and never written when it looks like it holds a
// credential.

import type { Action } from './decide.ts';
import { GATHER_VERSION } from './gather.ts';
import { type Json, type JsonObject, Missing, Read, parseJson } from './json.ts';
import type { RawWorkItem } from './raw.ts';
import { type Checkpoint, type Next, checkpoints } from './record.ts';
import { RUN_KINDS, type RunKind } from './run-name.ts';

export interface Fixture {
  /** The `gather` version it was recorded with: the history test refuses another. */
  readonly gather: number;
  readonly number: number;
  readonly raw: RawWorkItem;
  readonly checkpoints: readonly Checkpoint[];
}

/** `.github/factory/guard-secrets.sh`'s patterns, the same strings (`fixture.test.ts` checks). */
export const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /github_pat_[A-Za-z0-9_]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./,
];

/** The first credential pattern the text matches, or `null`. */
export const credentialIn = (text: string): RegExp | null =>
  CREDENTIAL_PATTERNS.find((pattern) => pattern.test(text)) ?? null;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const isList = (value: Json): value is readonly Json[] => Array.isArray(value);

const isObject = (value: Json): value is JsonObject =>
  value instanceof Object && !Array.isArray(value);

/** The same JSON with every object's keys in sorted order, which `JSON.stringify` keeps. */
function sortKeys(value: Json): Json {
  if (isList(value)) return value.map(sortKeys);

  if (!isObject(value)) return value;

  const entries: [string, Json][] = [];

  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) entries.push([key, sortKeys(child)]);
  }

  return Object.fromEntries(entries.sort(([a], [b]) => compare(a, b)));
}

const stable = (value: Json): string => JSON.stringify(sortKeys(value));

/** A list in an order of its own content, whatever order GitHub answered it in. */
const sorted = (list: Read): Json[] =>
  list
    .items()
    .map((item) => item.json())
    .sort((a, b) => compare(stable(a), stable(b)));

/**
 * The raw answers with the lists GitHub doesn't promise an order for (check runs, statuses,
 * workflow runs) sorted by their content. `observe` reads none of them by position.
 */
function canonical(raw: RawWorkItem): RawWorkItem {
  const perCommit = (list: Json, name: string, key: string): Json[] =>
    new Read(list, name).items().map((entry) => ({
      sha: entry.field('sha').text(),
      [key]: sorted(entry.field(key)),
    }));

  return {
    ...raw,
    checks: perCommit(raw.checks, 'checks', 'checkRuns'),
    statuses: perCommit(raw.statuses, 'statuses', 'statuses'),
    runs: sorted(new Read(raw.runs, 'runs')),
  };
}

/** The fixture for what `gather` read about one Work item. */
export function fixtureOf(raw: RawWorkItem): Fixture {
  const ordered = canonical(raw);

  return {
    gather: GATHER_VERSION,
    number: raw.number,
    raw: ordered,
    checkpoints: checkpoints(ordered),
  };
}

/** A fixture as its file's text: keys sorted, two-space indents. Refuses one that holds a credential. */
export function serialize(fixture: Fixture): string {
  const json = parseJson(JSON.stringify(fixture), `the fixture for #${fixture.number}`);
  const text = `${JSON.stringify(sortKeys(json), null, 2)}\n`;
  const credential = credentialIn(text);

  if (credential !== null) {
    throw new Error(
      `The fixture for #${fixture.number} matches a credential pattern (${credential.source}), so it isn't written.`,
    );
  }

  return text;
}

function parseKind(read: Read): RunKind {
  const text = read.text();
  const kind = RUN_KINDS.find((candidate) => candidate === text);

  if (kind === undefined) throw new Missing(`${read.path} is not an Executor's kind`);

  return kind;
}

function parseAction(read: Read): Action {
  const type = read.field('type').text();

  if (type === 'nothing') return { type };

  if (type === 'start') {
    const attempt = read.field('attempt');

    return {
      type,
      executor: parseKind(read.field('executor')),
      item: read.field('item').number(),
      head: read.field('head').optionalText(),
      attempt: attempt.absent() ? null : attempt.number(),
      minor: read.field('minor').boolean(),
    };
  }

  if (type === 'hand-over' || type === 'withdraw')
    return { type, reason: read.field('reason').text() };

  if (type === 'rerun') {
    return {
      type,
      head: read.field('head').text(),
      checks: read
        .field('checks')
        .items()
        .map((check) => check.text()),
    };
  }

  throw new Missing(`${read.path}.type is not one of decide's actions`);
}

function parseNext(read: Read): Next {
  const unknown = read.field('unknown');

  if (!unknown.absent()) return { unknown: unknown.text() };

  return { action: parseAction(read.field('action')), evidence: read.field('evidence').text() };
}

/**
 * A fixture from its file's text. Throws `Missing` for one recorded with another `gather` version,
 * saying how to record it again, or one that doesn't read as a fixture.
 */
export function parseFixture(text: string, path: string): Fixture {
  const read = new Read(parseJson(text, path), path);
  const number = read.field('number').number();
  const version = read.field('gather').number();

  if (version !== GATHER_VERSION) {
    throw new Missing(
      `${path} was recorded with gather version ${version}, and gather is version ${GATHER_VERSION} now: record it again with \`node tools/conductor/main.ts record ${number}\`.`,
    );
  }

  const raw = read.field('raw');
  const part = (key: string): Json => raw.field(key).value ?? null;

  return {
    gather: version,
    number,
    raw: {
      number: raw.field('number').number(),
      owner: raw.field('owner').text(),
      ticket: part('ticket'),
      blockers: part('blockers'),
      pullRequest: part('pullRequest'),
      checks: part('checks'),
      statuses: part('statuses'),
      comments: part('comments'),
      mentions: part('mentions'),
      main: part('main'),
      deploys: part('deploys'),
      inclusions: part('inclusions'),
      runs: part('runs'),
    },
    checkpoints: read
      .field('checkpoints')
      .items()
      .map((checkpoint) => ({
        at: checkpoint.field('at').text(),
        events: checkpoint
          .field('events')
          .items()
          .map((event) => event.text()),
        building: checkpoint
          .field('building')
          .items()
          .map((number) => number.number()),
        next: parseNext(checkpoint.field('next')),
      })),
  };
}
