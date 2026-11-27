// The conductor runs with Node alone, without `pnpm install` (ADR-0075), and the factory never adds
// a package (ADR-0050): this package has no dependencies of any kind, and none may be added.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const manifest = readFileSync(new URL('package.json', import.meta.url), 'utf8');

test('the conductor has no dependencies', () => {
  assert.doesNotMatch(manifest, /"(dev|peer|optional)?[dD]ependencies"/);
});
