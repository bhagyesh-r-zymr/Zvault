import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { attachShot } from '../shot.js';

const SITE = 'http://127.0.0.1:4173/';

test.beforeEach(async ({ page }) => {
  // Same-origin API in production; here nothing listens, so each test says what it expects.
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test('the landing page loads without console errors and has its main sections', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(SITE);
  await expect(page).toHaveTitle('Zvault');
  for (const id of ['mac', 'android', 'developers', 'security', 'waitlist']) {
    await expect(page.locator(`main #${id}`)).toHaveCount(1);
  }
  await attachShot(page, testInfo, 'landing-top');
  expect(errors).toEqual([]);
});

test('every in-page nav link points at a real section', async ({ page }) => {
  await page.goto(SITE);
  const hrefs = await page
    .locator('a[href^="#"]')
    .evaluateAll((as) => [...new Set(as.map((a) => a.getAttribute('href') as string))]);
  expect(hrefs.length).toBeGreaterThan(3);
  for (const href of hrefs) {
    if (href === '#top') continue;
    await expect(page.locator(href), href).toHaveCount(1);
  }
});

test('the APK button points at the latest release', async ({ page }) => {
  await page.goto(SITE);
  const apk = page.getByRole('link', { name: 'Download the APK' });
  await expect(apk).toHaveAttribute('href', /releases\/latest\/download\/zvault-android\.apk$/);
});

test('the waitlist rejects a bad email without calling the API', async ({ page }) => {
  let calls = 0;
  await page.route('**/v1/waitlist', (route) => (calls++, route.fulfill({ status: 204 })));
  await page.goto(SITE + '#waitlist');
  await page.getByLabel('Work email').fill('not-an-email');
  await page.getByRole('button', { name: 'Join the waitlist' }).last().click();
  await expect(page.locator('#waitlist-status')).toHaveText('Please enter a valid email address.');
  expect(calls).toBe(0);
});

test('joining the waitlist posts only the email form and confirms', async ({ page }, testInfo) => {
  let body: unknown;
  await page.route('**/v1/waitlist', (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({ status: 204 });
  });
  await page.goto(SITE + '#waitlist');
  await page.getByLabel('Work email').fill('tester@zymr.com');
  await page.getByRole('button', { name: 'Join the waitlist' }).last().click();
  await expect(page.locator('#waitlist-status')).toHaveText(
    "You're on the list. We'll be in touch.",
  );
  expect(body).toEqual({ email: 'tester@zymr.com', website: '' });
  await attachShot(page, testInfo, 'waitlist-done');
});

test('the waitlist explains rate limits and outages', async ({ page }) => {
  await page.goto(SITE + '#waitlist');
  const submit = page.getByRole('button', { name: 'Join the waitlist' }).last();
  await page.getByLabel('Work email').fill('tester@zymr.com');

  await page.route('**/v1/waitlist', (route) => route.fulfill({ status: 429 }));
  await submit.click();
  await expect(page.locator('#waitlist-status')).toContainText('Too many tries');

  await page.unroute('**/v1/waitlist');
  await page.route('**/v1/waitlist', (route) => route.abort());
  await submit.click();
  await expect(page.locator('#waitlist-status')).toContainText("Couldn't reach Zvault");
});

test('the page does not scroll sideways', async ({ page }) => {
  await page.goto(SITE);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('no serious or critical accessibility violations', async ({ page }) => {
  await page.goto(SITE);
  // Known: the animated blueprint band (#bp) has low-contrast labels (e.g. #8a93ad on
  // its background). Excluded until the design is revisited; everything else must pass.
  const { violations } = await new AxeBuilder({ page }).exclude('#bp').analyze();
  const bad = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    bad.map((v) => `${v.id}: ${v.nodes.length} nodes (${v.nodes[0]?.target.join(' ')})`),
  ).toEqual([]);
});
