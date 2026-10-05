import type { Page, TestInfo } from '@playwright/test';

// Screenshots are attached to the report for people to look at. They are not
// pixel-compared: fonts and anti-aliasing differ between machines and would make
// the suite flaky.
export async function attachShot(page: Page, testInfo: TestInfo, name: string, fullPage = false) {
  await testInfo.attach(`${name}-${testInfo.project.name}`, {
    body: await page.screenshot({ fullPage }),
    contentType: 'image/png',
  });
}
