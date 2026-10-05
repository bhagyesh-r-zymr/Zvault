# End-to-end tests

Two suites. Both run on Linux, so they cost no macOS minutes.

| Suite                          | Covers                                             | Runs                                       |
| ------------------------------ | -------------------------------------------------- | ------------------------------------------ |
| Playwright (`site/`, `share/`) | Landing page, share page (smoke, axe, screenshots) | Every PR that touches them (`e2e-web.yml`) |
| WebdriverIO (`desktop/`)       | The real Mac app through `tauri-driver`            | Nightly and on demand (`e2e-desktop.yml`)  |

## Playwright

```sh
pnpm --filter @zvault/shared build
pnpm --filter @zvault/e2e exec playwright install chromium
pnpm --filter @zvault/e2e test:web
```

It starts the landing page and a production build of the share page itself. The share page's API is mocked, with items encrypted in the test the same way the app does, so no backend is needed. Screenshots are attached to the HTML report (not pixel-compared). To use a Chromium you already have, set `PW_CHROMIUM_PATH`.

## Mac app (WebdriverIO + tauri-driver)

The app is built for Linux (WebKitGTK), so it is the same React UI and Rust core as on the Mac, but not the macOS shell (Touch ID, Keychain, window effects).

```sh
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev webkit2gtk-driver xvfb
cargo install tauri-driver --locked
pnpm --filter @zvault/desktop exec tauri build --debug --no-bundle
xvfb-run -a pnpm --filter @zvault/e2e test:desktop
```

Without an API only the signed-out screens run. To also run the sign-up test, start the API with `MAIL_TRANSPORT=log` and `CORS_ORIGINS=tauri://localhost,http://tauri.localhost`, log to a file and pass it as `ZVAULT_API_LOG`.
