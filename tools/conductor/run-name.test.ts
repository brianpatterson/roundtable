import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeRunName, parseRunName } from './run-name.ts';

test('a run is named <kind> #<item> <sha7>', () => {
  assert.equal(
    makeRunName({ kind: 'ci-fix', item: 289, sha: '0123456789abcdef' }),
    'ci-fix #289 0123456',
  );
  assert.equal(makeRunName({ kind: 'build', item: 12, sha: null }), 'build #12 -');
});

test('a name parses back to the run it names', () => {
  assert.deepEqual(parseRunName('rework #7 abcdef0'), { kind: 'rework', item: 7, sha: 'abcdef0' });
  assert.deepEqual(parseRunName('build #12 -'), { kind: 'build', item: 12, sha: null });

  for (const kind of ['build', 'ci-fix', 'review', 'rework', 'conflict', 'mention'] as const) {
    const run = { kind, item: 3, sha: '1234567' };

    assert.deepEqual(parseRunName(makeRunName(run)), run);
  }
});

test("any other run's name isn't an Executor run", () => {
  for (const name of [
    'CI',
    'Deploy',
    'deploy #12 abcdef0',
    'build #12',
    'build 12 abcdef0',
    'build #0 abcdef0',
    'build #12 ABCDEF0',
    'build #12 abcdef01',
    ' build #12 abcdef0',
    'build #12 abcdef0 again',
  ]) {
    assert.equal(parseRunName(name), null, name);
  }
});
