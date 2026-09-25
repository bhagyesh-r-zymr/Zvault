# Shipping the macOS app

The `Release macOS app` workflow (`.github/workflows/release-macos.yml`) builds a
universal `Zvault.dmg` (Apple silicon and Intel) on a GitHub macOS runner.

## Try it now (unsigned)

1. In GitHub, open **Actions → Release macOS app → Run workflow**.
2. When it finishes, download the `Zvault-macOS` artifact and unzip it.
3. Open the `.dmg` and drag **Zvault** to **Applications**.
4. The first time, right-click Zvault → **Open** → **Open** (macOS blocks unsigned apps
   on a double-click). On macOS 15 and later, go to **System Settings → Privacy &
   Security** and click **Open Anyway** instead.

Installed copies update themselves from later releases once the updater key is set up;
see [auto-update.md](auto-update.md).

Release builds talk to the `ZVAULT_API_URL` repository variable, or to the demo server
`https://52-66-189-120.sslip.io` while it is unset. Touch ID unlock does not work in an
unsigned build.

## Signed and notarized releases

You need a paid [Apple Developer Program](https://developer.apple.com/programs/)
membership ($99/year).

1. **Create a Developer ID Application certificate.** In Xcode → Settings → Accounts →
   Manage Certificates, click **+** → _Developer ID Application_. Then in Keychain
   Access, right-click the certificate → **Export** as `.p12` with a password.
2. **Find your Team ID** at developer.apple.com → Account → Membership details.
3. **Create an app-specific password** for notarization at appleid.apple.com →
   Sign-In and Security → App-Specific Passwords.
4. **Add repository secrets** (Settings → Secrets and variables → Actions):

   | Secret                       | Value                                                                             |
   | ---------------------------- | --------------------------------------------------------------------------------- |
   | `APPLE_CERTIFICATE`          | `base64 -i certificate.p12 \| pbcopy`, then paste                                 |
   | `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password                                                        |
   | `APPLE_SIGNING_IDENTITY`     | e.g. `Developer ID Application: Your Name (TEAMID)` (`security find-identity -v`) |
   | `APPLE_ID`                   | your Apple ID email                                                               |
   | `APPLE_PASSWORD`             | the app-specific password                                                         |
   | `APPLE_TEAM_ID`              | your 10-character Team ID                                                         |

5. **Add repository variables** (same page, _Variables_ tab):
   - `ZVAULT_API_URL`: the deployed API, e.g. `https://api.zvault.example`. It is baked
     into the app and added to its Content Security Policy.
   - `ZVAULT_SHARE_ORIGIN`: where share links open, e.g. `https://share.zvault.example`.
     Defaults to `ZVAULT_API_URL`.
   - `ZVAULT_SIGN_IN_URL`: the address printed on Emergency Kits. Defaults to
     `ZVAULT_API_URL`.
6. **Release:** run **Release macOS app** from the Actions tab with a release tag such
   as `v0.1.0`, or push the tag (`git tag v0.1.0 && git push origin v0.1.0`). The
   workflow signs, notarizes and staples the app when the secrets are set, then
   publishes a GitHub Release with the `.dmg` and the `zv` binary.

## Still to do before Touch ID works in a release

Touch ID keeps the vault key in the data-protection Keychain, which needs a
`keychain-access-groups` entitlement tied to the Team ID and an embedded provisioning
profile for the Developer ID app. Add `src-tauri/Entitlements.plist` and set
`bundle.macOS.entitlements` once the Team ID is known.

## Build locally on a Mac

```sh
xcode-select --install
curl https://sh.rustup.rs -sSf | sh
corepack enable
pnpm install
pnpm --filter @zvault/shared build
cd apps/desktop
VITE_API_URL=https://api.zvault.example pnpm tauri build
# → target/release/bundle/dmg/Zvault_<version>_aarch64.dmg
```
