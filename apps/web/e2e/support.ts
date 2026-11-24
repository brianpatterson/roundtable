import { readFile } from 'node:fs/promises';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { API_LOG, SCREENSHOTS_DIR } from './paths';

/**
 * Screenshots the page in the light and the dark theme, full length, for the reviewer (ADR-0065):
 * `screenshots/<project>/<name>-<theme>.png`, in the CI artifact and attached to the report.
 * They aren't compared with anything; a person or the reviewer looks at them.
 */
export async function screenshotThemes(page: Page, testInfo: TestInfo, name: string) {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });

    const file = path.join(SCREENSHOTS_DIR, testInfo.project.name, `${name}-${colorScheme}.png`);

    await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
    await testInfo.attach(`${name}-${colorScheme}`, { path: file, contentType: 'image/png' });
  }

  await page.emulateMedia({ colorScheme: null });
}

/**
 * Fails on any WCAG 2.2 A or AA violation axe finds on the page as it is now, in the light and
 * the dark theme (contrast differs between them).
 */
export async function expectAccessible(page: Page) {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await test.step(`axe, ${colorScheme} theme`, () => expectAccessibleNow(page));
  }

  await page.emulateMedia({ colorScheme: null });
}

async function expectAccessibleNow(page: Page) {
  // Mid fade-in, text is translucent and axe reports it as low contrast (a dialog opening).
  // An endless animation (a spinner) never finishes, so it doesn't count.
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== 'running' ||
          animation.effect?.getTiming().iterations === Infinity,
      ),
  );

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();

  expect(
    results.violations.map(({ id, help, nodes }) => ({
      id,
      help,
      targets: nodes.map((node) => node.target.join(' ')),
    })),
  ).toEqual([]);
}

/**
 * The confirmation link the API "sent" to `email`. With no Resend key the API logs each email
 * instead (one JSON line from Pino), so the test reads the link from the log, as a developer does.
 */
export async function confirmationLink(email: string): Promise<string> {
  const latestLink = async () =>
    (await readFile(API_LOG, 'utf8'))
      .split('\n')
      .filter((line) => line.includes(email))
      .map((line) => /https?:\/\/\S+verify-email\S+/.exec(line)?.[0])
      .findLast((match) => match !== undefined);

  await expect
    .poll(latestLink, { message: `no confirmation email to ${email} in ${API_LOG}` })
    .toBeDefined();

  const link = await latestLink();

  if (link === undefined) throw new Error(`the confirmation email to ${email} disappeared`);

  // A JSON string ends at the first quote or escaped newline after the URL.
  return link.replace(/(\\n|").*$/, '');
}
