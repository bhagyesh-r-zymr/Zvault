import { expect } from '@wdio/globals';
import { readFileSync } from 'node:fs';

// Without the API only the signed-out screens can be reached. With it
// (ZVAULT_API_LOG points at its log, MAIL_TRANSPORT=log) the sign-up e-mail
// and code steps run for real.
const API_LOG = process.env.ZVAULT_API_LOG;

const heading = () => $('h1');

async function fill(label: string, value: string) {
  const input = await $(`//label[normalize-space()="${label}"]/following::input[1]`);
  await input.waitForDisplayed();
  await input.setValue(value);
}

async function click(text: string) {
  const el = await $(`//button[normalize-space()="${text}"]`);
  await el.waitForClickable();
  await el.click();
}

describe('Zvault Mac app', () => {
  // Every test starts from a freshly loaded app, signed out.
  beforeEach(async () => {
    await browser.refresh();
    await heading().waitForDisplayed();
  });

  it('opens on the sign-in screen', async () => {
    await expect(browser).toHaveTitle('Zvault');
    await heading().waitForDisplayed();
    await expect(heading()).toHaveText(expect.stringMatching(/Sign in to Zvault|Welcome back/));
    await expect($('button=Create an account')).toBeDisplayed();
    await expect($('button=Forgot master password?')).toBeDisplayed();
  });

  it('shows the end-to-end encryption promise', async () => {
    await expect($('.auth-badge')).toHaveText(expect.stringContaining('End-to-end encrypted'));
  });

  it('moves between sign-in and the first sign-up step', async () => {
    await click('Create an account');
    await expect(heading()).toHaveText('Create your Zvault account');
    await expect($('ol.steps')).toHaveAttribute('aria-label', 'Step 1 of 4');
    await click('I already have an account');
    await expect(heading()).toHaveText(/Sign in to Zvault|Welcome back/);
  });

  it('opens account recovery and comes back', async () => {
    await click('Forgot master password?');
    await heading().waitForDisplayed();
    await expect(heading()).not.toHaveText(/Sign in to Zvault|Welcome back/);
  });

  if (API_LOG) {
    it('signs up with an e-mailed code and reaches the master password step', async () => {
      await click('Create an account');
      await fill('Email', 'e2e@example.com');
      await click('Send code');
      await expect(heading()).toHaveText('Check your email');

      const code = await browser.waitUntil(
        () => /verification code is (\d{6})/.exec(readFileSync(API_LOG, 'utf8'))?.[1] ?? false,
        { timeoutMsg: 'no sign-up code in the API log' },
      );
      await fill('Verification code', code as string);
      await click('Verify');
      await expect(heading()).toHaveText('Choose a master password');
    });
  } else {
    it('says so when the server cannot be reached', async () => {
      await click('Create an account');
      await fill('Email', 'e2e@example.com');
      await click('Send code');
      await $('[role="alert"], .error').waitForDisplayed();
    });
  }
});
