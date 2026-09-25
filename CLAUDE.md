# CLAUDE.md

Guidance for Claude Code (and anyone else) working in this repository. The product overview and crypto design are in `README.md`.

## This repository is public

Never commit secrets, keys, tokens, `.env` files, AWS account ids, or anything about other apps that share the demo server. Secrets live in GitHub Actions secrets, in `.env` on the server, or on the owner's Mac.

## Layout

pnpm workspaces + Turborepo drive the TypeScript side; a Cargo workspace at the root drives Rust (`crates/*` and `apps/desktop/src-tauri`).

| Path                                    | What it is                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------------- |
| `apps/api`                              | NestJS backend (TypeScript, ESM, Drizzle + PostgreSQL). Stores only ciphertext and verifiers. |
| `apps/desktop`                          | macOS app: Tauri 2, React/Vite UI in `src/`, Rust in `src-tauri/`.                            |
| `apps/share-web`                        | Static page (served at `/share/`) that opens share links and decrypts them in the browser.    |
| `apps/site`                             | Plain HTML/CSS/JS landing page (served at `/`). No build step.                                |
| `apps/mobile`                           | Android app in Flutter; Rust core via flutter_rust_bridge (`crates/zvault-mobile`).           |
| `crates/zvault-crypto`                  | All crypto: Argon2id + Secret Key (2SKD), XChaCha20-Poly1305, SRP. Keys stay in Rust.         |
| `crates/zvault-cli`, `zvault-agent`     | The `zv` CLI and agent pairing (see `docs/agent-cli.md`).                                     |
| `crates/zvault-otp`, `zvault-passwords` | TOTP and password generation/strength.                                                        |
| `crates/zvault-emergency-kit`           | Renders the Emergency Kit PDF on the device.                                                  |
| `packages/shared`                       | Wire contracts (zod schemas + types). KDF floors here must match `zvault-crypto`.             |
| `infra`                                 | AWS CDK app (not what runs the demo).                                                         |
| `deploy/ec2`                            | The single-box demo deploy: compose, nginx, setup and deploy scripts.                         |
| `docs`                                  | Agent CLI, auto-update and macOS release notes.                                               |

## Build and test

Node 22 (`.nvmrc`), pnpm 10, Rust stable. Build `packages/shared` first or the API and desktop can't resolve `@zvault/shared`.

```sh
pnpm install
pnpm --filter @zvault/shared build
pnpm build && pnpm lint && pnpm typecheck && pnpm test   # all TS packages via Turbo
pnpm format:check                                        # Prettier, also checks Markdown

cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked

# API locally
docker compose up -d
cp apps/api/.env.example apps/api/.env
pnpm --filter @zvault/api db:migrate
pnpm --filter @zvault/api dev          # sign-up codes print to this log

# Desktop app
pnpm --filter @zvault/desktop tauri dev

# Android app
cd apps/mobile && flutter pub get && flutter analyze && flutter test
```

Linux needs `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev` for the Tauri crate. API tests use vitest (not jest). CI (`.github/workflows/ci.yml`) runs only the jobs a change touches: TypeScript, Rust, macOS clippy on Rust PRs, Android, and a CDK synth.

## How we work

- **`main` only.** No `dev` branch. Branch per change, open a PR against `main`.
- **Merge your own PR once CI is green**, then report. No need to wait for a review.
- **Every merge to `main` auto-deploys the demo** (`.github/workflows/deploy-demo.yml`) when the API, share page, site or `deploy/ec2` change. It runs migrations and checks `/`, `/share/` and `/v1/health`. Anything merged is live within minutes.
- **Deploys overwrite** `compose.yml`, `nginx-zvault.conf`, `setup.sh` and `deploy.sh` on the server from `deploy/ec2/`. Only `.env` and `certs/` survive, so change the server by changing those files here, never by hand.
- **Releases** go through Actions > "Release macOS app" with a `release_tag` (for example `v0.1.3`). It publishes the universal `.dmg`, the `zv` binary and the auto-update manifest.
- **Database changes** need a Drizzle migration (`pnpm --filter @zvault/api db:generate`) committed with the schema change.
- **Zero-knowledge is non-negotiable:** the server must never see plaintext, the master password or the Secret Key. Share keys stay in the URL fragment.
