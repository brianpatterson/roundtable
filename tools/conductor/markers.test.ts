// The markers must be the strings the factory's scripts write, or the Conductor counts nothing.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MARKERS, isMarked } from './markers.ts';

const factory = new URL('../../.github/factory/', import.meta.url);

const scripts = readdirSync(factory)
  .filter((file) => file.endsWith('.sh') && !file.startsWith('test-'))
  .map((file) => readFileSync(new URL(file, factory), 'utf8'))
  .join('\n');

test('every marker is written by a script in .github/factory', () => {
  for (const marker of MARKERS)
    assert.ok(scripts.includes(marker), `${marker} isn't in .github/factory`);
});

test('a marker that is a prefix of another is still told apart', () => {
  assert.ok(isMarked('<!-- factory-review-changes -->\nRe-reviewed abc1234'));
  assert.ok(!isMarked('<!-- factory-reviewer -->'));
  assert.ok(!isMarked('Thanks! <!-- factory-review -->'));
});
