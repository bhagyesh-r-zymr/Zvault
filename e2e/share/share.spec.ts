import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { makeLink, mockShareApi } from './fixtures.js';
import { attachShot } from '../shot.js';

const PAGE = 'http://127.0.0.1:4174/share/';
const future = () => new Date(Date.now() + 3600_000).toISOString();

test('a link with no key says it is incomplete', async ({ page }) => {
  await page.goto(PAGE);
  await expect(page.getByRole('alert')).toContainText('This link is incomplete');
});

test('an expired or revoked link says so and drops the key from the address bar', async ({
  page,
}) => {
  const link = makeLink({ v: 1, title: 'x' });
  await mockShareApi(page, { check: { status: 404 } });
  await page.goto(PAGE + link.fragment);
  await expect(page.getByRole('alert')).toContainText('expired, was revoked');
  expect(page.url()).not.toContain('#');
});

test('revealing decrypts in the browser and the key never reaches the server', async ({
  page,
}, testInfo) => {
  const link = makeLink({
    v: 1,
    title: 'Staging database',
    username: 'admin',
    password: 'correct-horse-battery',
    url: 'https://db.example.com',
    notes: '<img src=x onerror=alert(1)>',
  });
  const calls = await mockShareApi(page, {
    check: { status: 200, body: { emailRequired: false } },
    open: { status: 200, body: { blob: link.blob, expiresAt: future(), viewsRemaining: 0 } },
  });
  await page.goto(PAGE + link.fragment);

  // Loading the page alone must not spend a view.
  await expect(page.getByRole('button', { name: 'Reveal shared item' })).toBeVisible();
  expect(calls.map((c) => c.action)).toEqual(['check']);
  await attachShot(page, testInfo, 'share-landing');

  await page.getByRole('button', { name: 'Reveal shared item' }).click();
  await expect(page.getByRole('heading', { name: 'Staging database' })).toBeVisible();
  await expect(page.getByText('admin', { exact: true })).toBeVisible();
  await expect(page.getByText('This was the last view')).toBeVisible();

  // The password is masked until asked for.
  await expect(page.getByText('correct-horse-battery')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show' }).click();
  await expect(page.getByText('correct-horse-battery')).toBeVisible();

  // Notes are shown as text, never parsed as HTML.
  await expect(page.locator('pre')).toHaveText('<img src=x onerror=alert(1)>');
  await expect(page.locator('pre img')).toHaveCount(0);

  // Only the derived access token is sent, never the link key.
  const urlKey = link.fragment.split('.')[1] as string;
  expect(JSON.stringify(calls)).not.toContain(urlKey);
  expect(page.url()).not.toContain('#');
  await attachShot(page, testInfo, 'share-revealed');

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test('a tampered ciphertext is reported as damaged', async ({ page }) => {
  const link = makeLink({ v: 1, title: 'x' });
  const bad = { ...link.blob, ct: link.blob.ct.slice(0, -2) + 'AA' };
  await mockShareApi(page, {
    check: { status: 200, body: { emailRequired: false } },
    open: { status: 200, body: { blob: bad, expiresAt: future(), viewsRemaining: 2 } },
  });
  await page.goto(PAGE + link.fragment);
  await page.getByRole('button', { name: 'Reveal shared item' }).click();
  await expect(page.getByRole('alert')).toContainText('damaged');
});

test('an email-restricted link asks for the email, then the code', async ({ page }) => {
  const link = makeLink({ v: 1, title: 'Team wifi', password: 'hunter2hunter2' });
  const calls = await mockShareApi(page, {
    check: { status: 200, body: { emailRequired: true } },
    code: { status: 200 },
    open: { status: 200, body: { blob: link.blob, expiresAt: future(), viewsRemaining: 1 } },
  });
  await page.goto(PAGE + link.fragment);
  await page.getByLabel('Your email').fill('Vivek@Zymr.com');
  await page.getByRole('button', { name: 'Send me a code' }).click();
  await expect(page.getByText('vivek@zymr.com')).toBeVisible();
  await page.getByLabel('One-time code').fill('123456');
  await page.getByRole('button', { name: 'Verify and reveal' }).click();
  await expect(page.getByRole('heading', { name: 'Team wifi' })).toBeVisible();
  expect(calls.find((c) => c.action === 'code')?.body).toMatchObject({ email: 'vivek@zymr.com' });
  expect(calls.find((c) => c.action === 'open')?.body).toMatchObject({
    email: 'vivek@zymr.com',
    code: '123456',
  });
});

test('a wrong code is explained and can be retried', async ({ page }) => {
  const link = makeLink({ v: 1, title: 'x' });
  await mockShareApi(page, {
    check: { status: 200, body: { emailRequired: true } },
    code: { status: 200 },
    open: { status: 403, body: { message: 'That code did not work.' } },
  });
  await page.goto(PAGE + link.fragment);
  await page.getByLabel('Your email').fill('a@b.co');
  await page.getByRole('button', { name: 'Send me a code' }).click();
  await page.getByLabel('One-time code').fill('000000');
  await page.getByRole('button', { name: 'Verify and reveal' }).click();
  await expect(page.getByRole('alert')).toContainText('That code did not work.');
  await expect(page.getByLabel('One-time code')).toBeVisible();
});

test('the page ships a strict CSP and no referrer', async ({ page }) => {
  await page.goto(PAGE);
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain('connect-src http://localhost:3000');
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
});
