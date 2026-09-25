# Auto-update

Installed copies of Zvault and `zv` update themselves from this repository's GitHub
Releases.

- **The app** checks `releases/latest/download/latest.json` when it starts. When there is
  a newer version it shows a banner; nothing installs until you click **Install and
  restart**. You can also check from **Settings → Account → Updates**. Restarting locks
  the vault.
- **`zv` inside Zvault.app** (what **Settings → Command line** links onto your PATH)
  updates with the app.
- **A standalone `zv`** (downloaded on its own) updates with `zv update`, or
  `zv update --check` to only look. If it lives in a folder you can't write to, such as
  `/usr/local/bin`, run `sudo zv update`.

Both check a signature before installing anything. The app uses the Tauri updater, which
verifies `Zvault.app.tar.gz` against the public key built into the app. `zv update`
verifies `zv-macos-universal` against the same key, and also checks that the signature was
made for the version it is installing, so an older release can't be served as a new one.

Builds from before auto-update (v0.1.0 and v0.1.1), dev builds, and release builds made
without the key below never update themselves. Install the first release that has
auto-update by hand once; later releases arrive on their own.

## One-time setup: the signing key

The release workflow signs updates when the repository has:

| Kind     | Name                                 | Value                           |
| -------- | ------------------------------------ | ------------------------------- |
| Secret   | `TAURI_SIGNING_PRIVATE_KEY`          | The private key file's contents |
| Secret   | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The key's password              |
| Variable | `TAURI_UPDATER_PUBKEY`               | The public key file's contents  |

Make the key on your Mac with the [GitHub CLI](https://cli.github.com/) signed in
(`gh auth login`), from any folder:

```sh
KEY=~/.tauri/zvault-updater.key
mkdir -p ~/.tauri
PW=$(openssl rand -base64 24)
npx -y @tauri-apps/cli@2 signer generate --ci -p "$PW" -w "$KEY"
gh secret set TAURI_SIGNING_PRIVATE_KEY -R bhagyesh-r-zymr/Zvault < "$KEY"
printf '%s' "$PW" | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD -R bhagyesh-r-zymr/Zvault
gh variable set TAURI_UPDATER_PUBKEY -R bhagyesh-r-zymr/Zvault --body "$(cat "$KEY.pub")"
echo "Key password (save it in your password manager): $PW"
unset PW
```

Keep `~/.tauri/zvault-updater.key` and its password somewhere safe and never commit them.
If they are lost, make a new pair: installed apps won't accept updates signed with it, so
everyone installs that release by hand once.

After that, publish releases as before (**Actions → Release macOS app**, `release_tag`).
Each release then also carries `Zvault.app.tar.gz`, its `.sig`, `latest.json` and
`zv-macos-universal.sig`. If the key is missing, the workflow still builds but warns that
the build will not update itself.
