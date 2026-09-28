# `zv`: Zvault on the command line

`zv` lets you, your scripts and the coding agents you approve (Claude Code,
Cursor, CI scripts on your Mac) use Zvault secrets. It never holds your master
password or a vault key: every command asks the running Zvault app, which
decides and decrypts. Where there is no app (CI, cloud AI agents), a read-only
token in `ZVAULT_TOKEN` lets it read one environment; see
[Cloud agents and CI](#cloud-agents-and-ci).

## Install

Release builds ship `zv` inside Zvault.app. In Zvault, use **Install
command-line tool**: it links `zv` (and the alias `zvault`) into
`/usr/local/bin` when that is writable, otherwise `~/.local/bin` (and tells you
the `PATH` line to add). The release
workflow also uploads `zv` on its own as the `zv-macOS` artifact.

The linked copy updates with the app. A standalone `zv` updates itself with
`zv update` (`--check` to only look); see [auto-update.md](auto-update.md).

## For you

```sh
zv status                               # running? locked? this terminal signed in?
zv unlock                               # bring Zvault forward and wait for unlock
zv signin                               # approve this terminal for a while
zv ls                                   # projects
zv ls zv://web/development              # secrets and folders in an environment
zv ls -r zv://web                       # every secret path below a place
zv read zv://web/development/DATABASE_URL
zv copy zv://web/production/STRIPE_KEY  # clipboard, cleared by Zvault later
zv set zv://web/development/DATABASE_URL          # prompts for the value, hidden
echo -n "$VALUE" | zv set zv://web/development/DATABASE_URL
zv env zv://web/development             # KEY="…" lines for a .env file
eval "$(zv env zv://web/development --format shell)"
zv run --env-from zv://web/development -- npm test
zv signout
```

Projects, environments, folders and logins:

```sh
zv projects                             # every project with its environments and folders
zv project create "Web" --env Development --env Staging --env Production
zv project rename zv://web "Website" --slug website
zv environment create zv://web QA --inherits staging
zv environment edit zv://web/qa --name Quality --no-inherit
zv folder create zv://web Stripe
zv set zv://web/production/SESSION_SECRET --generate 48   # random, never printed
zv rm zv://web/staging/DATABASE_URL --yes                 # that environment's value
zv rm zv://web/staging/DATABASE_URL --all-environments --yes
zv folder delete zv://web stripe --yes                     # must be empty
zv environment delete zv://web/qa --yes
zv project delete zv://web --yes
zv item list                                               # never passwords
zv item create --title GitHub --username me --url https://github.com --generate
zv item get GitHub --field password
zv item edit GitHub --generate 40
zv item delete GitHub --yes
zv guide                                                   # the guide for AI agents
```

Listings take `--json`. Every change runs as you and always asks in Zvault,
even in a signed-in terminal; deletes also need `--yes`. Changes are made by
the app's own projects store (which seals metadata in Rust); item passwords
are opened and sealed in Rust, and the web view only moves ciphertext.

Without `--agent`, commands run as you. Each one asks for approval in Zvault
(with Touch ID when Touch ID unlock is set up), and when Zvault is locked it
comes forward and waits for you to unlock. `zv signin` approves the terminal
session (everything started from that terminal window, by its session id) for
10 minutes of inactivity and at most an hour, or until Zvault locks. `zv set`
and `zv signin` always ask. Agents started from a signed-in terminal share its
approval, so sign out before starting one there, or give it its own identity
below.

`zv copy` never sends the value to the terminal: the app puts it on the
clipboard and clears it after the delay set in Zvault.

## For agents

```sh
zv agent pair --name "Claude Code"      # approve in Zvault; code shown in both places
export ZV_AGENT="Claude Code"           # in the agent's environment
zv run --env DATABASE_URL=zv://web/development/DATABASE_URL -- npm test
zv read zv://web/development/STRIPE_KEY
zv env zv://web/development             # only the secrets in its scopes
zv agent status
zv agent unpair
```

Commands act as an agent when given `--agent NAME` or `ZV_AGENT`. An agent
cannot copy, sign in or change anything (set, rm, project, environment, folder,
item); those run as you. `zv projects` as an agent shows only what its scopes
reach. `zv guide` (or `zv help agents`) prints the full guide an agent needs.

## Cloud agents and CI

A CI job or a cloud AI agent has no Zvault app to ask. Give it a token
instead: in Zvault, open the project, then **Access > Tokens for CI and cloud
agents > New token**, pick the environment and how long it lasts (1 day to a
year), and copy the `zvt_…` token it shows once.

```sh
# Linux (static binary, x86_64); macOS uses the zv inside Zvault.app
curl -fsSL -o zv https://github.com/bhagyesh-r-zymr/Zvault/releases/latest/download/zv-linux-x86_64
chmod +x zv
export ZVAULT_TOKEN=zvt_…               # from your CI's secret store
./zv status                             # which place the token reads
./zv run --env-from zv://web/production -- ./deploy.sh
./zv read zv://web/production/DATABASE_URL
eval "$(./zv env zv://web/production --format shell)"
```

GitHub Actions:

```yaml
- run: zv run --env-from zv://web/production -- ./deploy.sh
  env:
    ZVAULT_TOKEN: ${{ secrets.ZVAULT_TOKEN }}
```

With `ZVAULT_TOKEN` set, `status`, `ls`, `read`, `env` and `run` read from the
server, without approvals; everything else still needs the app. `zv` talks to
the server it was built for; set `ZVAULT_SERVER` to use another one. It needs
`curl`.

What a token can do:

- Read one environment of one project, plus the environments it inherits
  from (a secret with no value there falls back, as in the app). It cannot
  change anything, and it cannot read other environments.
- It expires (at most a year), and anyone who manages the environment can
  revoke it on the same screen; revoking works at once.
- It stops working when its creator loses access to the environment, when the
  environment is deleted, or when the environment's key is rotated (the app
  then shows "Re-issue needed").

How it stays zero-knowledge: the token is made on your Mac, and it is itself
the key. From its secret, `zv` derives an auth key (sent to prove the token;
the server stores only its SHA-256) and a wrap key (never sent). The Mac wraps
the project key and the environment keys with the wrap key; the server stores
those wraps, bound to the token id, the environment and its key version. `zv`
unwraps them and decrypts the values locally, so the server still sees only
ciphertext. Treat the token like the secrets it opens. The scheme is in
`crates/zvault-crypto/src/token.rs` and `packages/shared/src/tokens.ts`; the
API is `apps/api/src/tokens` (its `TokenActivity` provider reports issued,
used, denied and revoked tokens).

## Paths

`zv://<project>/<environment>/[<folder>/]<KEY>`, as in the app and
`parseSecretPath` in `@zvault/shared`: for example
`zv://payments-api/production/billing/STRIPE_SECRET_KEY`. Project,
environment and folder are slugs (lowercase letters, digits and dashes); `KEY`
is the secret's variable name, and one secret holds a value per environment.
Folders are one level deep, so three parts mean no folder and four mean a
folder. A place for `ls`, `env` and `--env-from` is `zv://project`,
`zv://project/environment`, or a folder with a trailing slash
(`zv://web/development/billing/`).

`zv env` and `--env-from` export each secret under its `KEY`. Two secrets with
the same `KEY` in different folders are an error; name one with `--env`.

An agent's scopes are paths (one secret) or places ending in `/*`:
`zv://web/*`, `zv://web/development/*`, `zv://web/development/billing/*`.

## How a request is decided

1. `zv` connects to `agent.sock` in the app's data directory
   (`~/Library/Application Support/com.zvault.desktop/`, or `$ZV_SOCKET`). The
   directory is `0700`, the socket `0600`, and the app checks the peer runs as
   the same user (`getpeereid` on macOS, `SO_PEERCRED` on Linux).
2. An agent sends its bearer token (in the login Keychain on macOS). The app
   stores only its SHA-256 and compares in constant time.
3. For an agent the app checks, in order: paused, every reference inside its
   scopes, Zvault unlocked, then the approval mode:
   - **Ask every time**: a prompt in the app, then Touch ID when Touch ID
     unlock is set up.
   - **15-minute session**: one approval covers the same references for 15
     minutes.
   - **While unlocked**: no prompt; locking Zvault ends it.

   For you: unlocked (waiting for it), then the terminal's sign-in or a
   prompt with Touch ID.

   Locking Zvault or changing an agent's settings ends every approval and
   sign-in and withdraws open prompts.

4. The UI says which project, environment and secret each path names and
   hands over the encrypted value; Rust decrypts it with the environment key.
   No secret value passes through the web view. `zv set` goes the other way:
   Rust seals the value (and, for a new secret, its metadata) and the UI
   uploads it.
5. Every use and denial is written to the activity log (references and
   outcome, never values) and the answer goes back over the socket.

`zv run` sets the values only in the child's environment and replaces them with
`********` in its stdout and stderr (values under 4 characters are not
masked). `--no-mask` hands the child the terminal instead.

Exit codes: the child's own code for `zv run`; 2 Zvault not reachable, 3 not
paired, 4 denied / out of scope / paused / timed out, 5 locked, 64 usage, 1
anything else (the app's reason is printed, for example "the folder still
holds 2 secrets").

## For the app UI

`apps/desktop/src/agents/api.ts` is the typed bridge. `agents/bridge.ts`
(`serveZv`, mounted by the app shell) answers lookups, listings and writes
from the synced projects; a value inherited from another environment ("Same
as Development") is decrypted with that environment's key.
`agents/AgentPrompts.tsx` shows the approval and pairing prompts, and
`agents/AgentsView.tsx` lists paired agents. Rust events:
`agent://approval-request`, `agent://pairing-request`, `agent://prompt-closed`,
`agent://resolve-request`, `agent://list-request`, `agent://write-request`,
`agent://structure-request`, `agent://change-request`, `agent://item-request`
(answered with `agent_ui_respond`), `agent://unlock-requested`,
`agent://activity`.

## Code

- `crates/zvault-agent`: reference format, wire protocol, policy, terminal
  sign-ins, activity log, output masking.
- `crates/zvault-cli`: the `zv` binary (`cloud.rs`: `ZVAULT_TOKEN`).
- `apps/desktop/src-tauri/src/agents/`: socket server and Tauri commands.
- `apps/desktop/src-tauri/src/cli_install.rs`: Install command-line tool.
