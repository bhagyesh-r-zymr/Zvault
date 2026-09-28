# Secret sync: GitHub Actions and AWS Secrets Manager

An environment can push its secrets to GitHub Actions secrets and to AWS
Secrets Manager, so CI and cloud services read the same values Zvault holds.
Set it up in the Mac app: a project's **Environments** page, **Sync** on an
environment.

## Zero-knowledge stays intact

Sync runs on a member's Mac, never on the Zvault server:

1. The web view hands the Rust core the _ciphertext_ of each value (what the
   project sync already holds) and the target.
2. Rust decrypts each value with the environment key, reads the provider
   credential from the login keychain, and sends the values straight to GitHub
   or AWS over TLS (`crates/zvault-sync`).
3. Only names and counts come back to the web view.

The targets themselves (repository, GitHub environment, AWS region and secret
name) live in the environment's encrypted metadata (`SyncTarget` in
`@zvault/shared`), so every member and device sees them and the server does
not. Credentials never leave the Mac that saved them.

## Targets

| Provider            | What it writes                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GitHub Actions      | One Actions secret per variable, in the repository or a GitHub environment. Each value is sealed to the repository's public key (libsodium sealed box) on the Mac. |
| AWS Secrets Manager | One secret holding the environment as a JSON object (`{"DATABASE_URL": "…"}`). Created on the first sync.                                                          |

Values an environment inherits ("falls back to Development") are synced like
`zv run` resolves them. Variables deleted in Zvault are deleted from GitHub on
the next sync (only names a Zvault sync wrote are touched); AWS gets the whole
object each time. Removing a target stops syncing and leaves what was pushed.

## When it syncs

- **On change**: while Zvault is unlocked, a Mac connected to the provider
  pushes an environment a couple of seconds after its values change, whichever
  device changed them. Turn this off per target to sync only by hand.
- **Sync now** in the app, or `zv sync zv://project/environment` (asks for
  approval in Zvault like every change).

Each target's last result ("Synced 5 minutes ago · 12 secrets pushed") is kept
on that Mac.

## Credentials

- **GitHub**: a fine-grained personal access token for the repositories, with
  **Secrets: read and write** (and **Environments: read and write** for
  environment secrets).
- **AWS**: access keys (optionally a session token) for an IAM identity allowed
  `secretsmanager:PutSecretValue` and `secretsmanager:CreateSecret` on the
  secrets it syncs, for example `arn:aws:secretsmanager:*:*:secret:payments-api/*`.

Zvault checks a credential when you connect it (GitHub `GET /user`, AWS STS
`GetCallerIdentity`) and shows who it belongs to.
