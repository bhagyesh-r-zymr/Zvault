import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Drives the real Mac app (Tauri, WebKitGTK on Linux) through tauri-driver.
// Build it first: pnpm --filter @zvault/desktop exec tauri build --debug --no-bundle
const root = resolve(import.meta.dirname, '../..');
const application = process.env.ZVAULT_APP ?? join(root, 'target/debug/zvault-desktop');
const tauriDriver = process.env.TAURI_DRIVER ?? join(homedir(), '.cargo/bin/tauri-driver');

let driver: ChildProcess | undefined;

export const config: WebdriverIO.Config = {
  runner: 'local',
  hostname: '127.0.0.1',
  port: 4444,
  specs: ['./specs/**/*.e2e.ts'],
  maxInstances: 1,
  capabilities: [
    {
      // @ts-expect-error tauri:options is not in the WebdriverIO types
      'tauri:options': { application },
      'wdio:enforceWebDriverClassic': true,
    },
  ],
  logLevel: 'warn',
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { ui: 'bdd', timeout: 120_000 },
  waitforTimeout: 20_000,

  onPrepare() {
    if (!existsSync(application)) throw new Error(`App not built: ${application}`);
  },
  beforeSession() {
    driver = spawn(tauriDriver, [], { stdio: [null, process.stdout, process.stderr] });
    // Give tauri-driver a moment to open its port.
    return new Promise((r) => setTimeout(r, 1500));
  },
  async afterSession() {
    driver?.kill();
  },
  afterTest: async (test, _ctx, { passed }) => {
    if (passed) return;
    const name = test.title.replace(/\W+/g, '-').toLowerCase();
    await browser
      .saveScreenshot(join(root, 'e2e/test-results', `desktop-${name}.png`))
      .catch(() => {});
  },
};
