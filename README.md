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

pnpm workspaces and Turborepo drive the TypeScript side; a Cargo workspace at the root drives the Rust side.

## Getting started

Prerequisites: Node 22 (`.nvmrc`), pnpm 10 (`corepack enable`), Rust stable, and Xcode command line tools on macOS.

```sh
pnpm install
pnpm build          # build every package
pnpm test           # TypeScript tests
cargo test --workspace

# Backend on http://localhost:3000 (try GET /v1/health)
docker compose up -d                    # PostgreSQL (+ Mailpit for trying SMTP)
cp apps/api/.env.example apps/api/.env
pnpm --filter @zvault/api db:migrate
pnpm --filter @zvault/api dev           # sign-up codes are printed to this log

# Desktop app (opens a native window)
pnpm --filter @zvault/desktop tauri dev
```

## Crypto at a glance

```text
master password ──Argon2id──┐                ┌─► unlock key ──unwraps──► keyset ──► vault keys ──► items
                            XOR ──► HKDF ──┤
Secret Key ──────HKDF───────┘                └─► SRP x ──► verifier g^x (the only thing the server stores)
```

All of this runs in Rust on the device (`crates/zvault-crypto`). The server receives ciphertext, nonces, KDF parameters and the Secret Key's public id prefix only. Minimum KDF strength and the ciphertext envelope are defined once in `packages/shared` and mirrored in the Rust crate.

## Sign-up and login

| Step | Endpoint                                       | What happens                                                                                                                                                                 |
| ---- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `POST /v1/auth/signup/start`                   | Emails a 6-digit code (15 min, 5 tries, 1 per minute). Always 202; a registered address gets a "you already have an account" email instead.                                  |
| 2    | `POST /v1/auth/signup/verify`                  | Exchanges the code for a single-use sign-up token (30 min).                                                                                                                  |
| 3    | `POST /v1/auth/signup/complete`                | The app generates the Secret Key, KDF salt, SRP verifier and sealed keyset in Rust and uploads everything but the Secret Key. The Emergency Kit screen shows the Secret Key. |
| 4    | `POST /v1/auth/login/start`                    | Returns KDF params and SRP `B`. Unknown emails get a stable decoy, so this can't be used to find accounts.                                                                   |
| 5    | `POST /v1/auth/login/finish`                   | Checks SRP proof `M1`, returns `M2`, a session token and the sealed keyset. The app verifies `M2` before opening the keyset.                                                 |
| –    | `GET /v1/auth/session`, `POST /v1/auth/logout` | Bearer-token session (stored hashed, `SESSION_TTL_MINUTES`).                                                                                                                 |

SRP is SRP-6a over the RFC 5054 3072-bit group with SHA-256; the exact spec is in `crates/zvault-crypto/src/srp.rs`. The Rust client and the TypeScript server are both checked against `crates/zvault-crypto/tests/srp-v1.json`, a vector produced by an independent implementation.

**Database:** PostgreSQL (Amazon RDS/Aurora in production) via Drizzle ORM; migrations live in `apps/api/drizzle`. API tests run against an in-process Postgres (PGlite), so no database is needed for `pnpm test`.

**Email:** `MAIL_TRANSPORT=log` prints messages to the API log for development. Set `MAIL_TRANSPORT=smtp` and the `SMTP_*` variables in `apps/api/.env` (see `.env.example`) to send real mail through any provider, or `MAIL_TRANSPORT=ses` to use the Amazon SES API with the IAM role on AWS. Production refuses the log transport and plaintext SMTP.
