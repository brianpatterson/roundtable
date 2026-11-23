// Fails if two ADRs share a number, or docs/adr/README.md's index and the ADR files disagree.
// Two pull requests written at the same time can both take the next number (#149, #155); git
// sees no conflict when the index rows land apart, so this is what catches it (ADR-0058).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(new URL('..', import.meta.url).pathname, 'docs/adr');
const problems: string[] = [];

const files = readdirSync(dir).filter((name) => /^\d{4}-.+\.md$/.test(name));
const byNumber = new Map<string, string[]>();

for (const file of files) {
  const number = file.slice(0, 4);
  byNumber.set(number, [...(byNumber.get(number) ?? []), file]);

  const heading = readFileSync(join(dir, file), 'utf8').match(/^# (\d{4})\. /m)?.[1];

  if (heading !== number) {
    problems.push(`${file}'s heading should start with "# ${number}. "`);
  }
}

for (const [number, names] of byNumber) {
  if (names.length > 1) {
    problems.push(`ADR-${number} is taken by ${names.length} files: ${names.join(', ')}`);
  }
}

// An index row is `| NNNN | [Title](NNNN-slug.md) | Status |`.
const index = readFileSync(join(dir, 'README.md'), 'utf8');

const rows = [...index.matchAll(/^\|\s*(\d{4})\s*\|\s*\[[^\]]*\]\(([^)]+)\)/gm)].map((match) => ({
  number: match[1]!,
  link: match[2]!,
}));

const linked = new Map<string, number>();

for (const { number, link } of rows) {
  linked.set(link, (linked.get(link) ?? 0) + 1);

  if (!files.includes(link)) {
    problems.push(`The index row for ${number} links ${link}, which doesn't exist`);
  } else if (!link.startsWith(`${number}-`)) {
    problems.push(`The index row numbered ${number} links ${link}`);
  }
}

for (const file of files) {
  const count = linked.get(file) ?? 0;

  if (count !== 1) {
    problems.push(`${file} has ${count} rows in docs/adr/README.md; it needs exactly one`);
  }
}

for (const problem of problems) {
  console.error(`✗ ${problem}`);
}

if (problems.length) {
  console.error(
    '\nAn ADR that lost its number to one merged first takes the next free number: rename the file,' +
      ' its heading, its index row and every link to it.',
  );
  process.exit(1);
}

console.log(`✓ ${files.length} ADRs, each with its own number and one index row`);
