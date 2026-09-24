# Zvault

A 1Password-style password manager. End-to-end encrypted. Zero-knowledge.

## Goal

Build a native **macOS app** with a backend on **AWS** that lets people store and share passwords safely.

## Must-have features

- **Sign up** with email + master password.
- **Emergency Kit** — a downloadable PDF with the account Secret Key, shown right after sign-up (like 1Password).
- **2FA (TOTP)** — set up by scanning a QR code in any authenticator app.
- **Vaults & items** — save, edit, search passwords and notes.
- **Sharing** — share an item by secure link (expiry + view limit) or by email to another user.

## Non-negotiables (security)

- **End-to-end encrypted.** Encrypt/decrypt only on the device. Server never sees plaintext, master password, or Secret Key.
- **Key derivation:** master password + Secret Key → strong KDF (Argon2id) → account key. Auth via SRP or similar (no password sent to server).
- **Share links:** decryption key lives in the URL fragment (`#...`), never sent to server.
- **AWS baseline:** KMS, least-privilege IAM, TLS 1.2+ everywhere, encryption at rest, WAF, CloudTrail, secrets in Secrets Manager.
- **macOS:** store local keys in Keychain; support Touch ID unlock.
- No secrets in this repo. Ever.

## Repository layout

| Path                   | What it is                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `apps/api`             | NestJS backend (TypeScript, ESM). Stores only ciphertext and public verifiers.                                    |
| `apps/desktop`         | macOS app: [Tauri 2](https://tauri.app) shell, React UI in `src/`, Rust in `src-tauri/`.                          |
| `crates/zvault-crypto` | Rust crypto core used by the app: Argon2id + Secret Key derivation (2SKD), XChaCha20-Poly1305, Secret Key format. |
| `packages/shared`      | Wire contracts (zod schemas + types) shared by the API and the app's UI.                                          |
| `apps/share-web`       | Static page that opens share links in the recipient's browser and decrypts them there.                            |

pnpm workspaces and Turborepo drive the TypeScript side; a Cargo workspace at the root drives the Rust side.

## Getting started

Prerequisites: Node 22 (`.nvmrc`), pnpm 10 (`corepack enable`), Rust stable, and Xcode command line tools on macOS.

```sh
pnpm install
pnpm build          # build every package
pnpm test           # TypeScript tests
cargo test --workspace

# Backend on http://localhost:3000 (try GET /v1/health)
cp apps/api/.env.example apps/api/.env
pnpm --filter @zvault/api dev

# Desktop app (opens a native window)
pnpm --filter @zvault/desktop tauri dev
```

## Crypto at a glance

```text
master password ──Argon2id──┐
                            XOR ──► account unlock key ──unwraps──► keyset ──► vault keys ──► items
Secret Key ──────HKDF───────┘
```

All of this runs in Rust on the device (`crates/zvault-crypto`). The server receives ciphertext, nonces, KDF parameters and the Secret Key's public id prefix only. Minimum KDF strength and the ciphertext envelope are defined once in `packages/shared` and mirrored in the Rust crate.

## Sharing

- **Links.** The app generates a 256-bit link key and a 128-bit share id, encrypts the item, and builds `https://<share page>/#<id>.<key>`. The whole link lives in the fragment, which browsers never send anywhere. From the key it derives an encryption key and an access token (HKDF-SHA256); the API stores the ciphertext and `SHA-256(access token)` only. Opening a link (`POST /v1/shares/links/:id/open`) requires the token, counts one view, and deletes the ciphertext when the view limit is reached or the link is revoked. Expiry is 5 minutes to 30 days, views 1 to 100. The recipient page waits for a click before opening, so mail scanners and link previews do not use up views.
- **Zvault users.** Each user publishes an X25519 sharing public key. Items are encrypted to the recipient with a key derived from ephemeral-static and static-static Diffie-Hellman, so the recipient knows which account sent it and the server cannot forge or redirect a share. Both people can compare a security code (key fingerprint) to rule out a substituted key. The recipient gets an email notice with no item data in it.
