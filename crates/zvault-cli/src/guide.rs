//! `zv guide` (also `zv help agents`): how an AI agent should use zv.

pub const GUIDE: &str = r#"zv guide: using Zvault from an AI agent (Claude Code and others)
==================================================================

Zvault is a password manager app. zv is its command line. It holds no keys:
every command asks the Zvault app running on this Mac, which decrypts,
encrypts and asks the person to approve. Never print secret values into the
conversation, into files you create, or into logs.

WHERE IT WORKS
  zv only works on a computer where the Zvault app is running and unlocked.
  It cannot reach Zvault from a cloud or remote agent yet. If `zv status`
  says "not running", ask the person to open Zvault; do not look for another
  way in.

PATHS
  Every secret has a path:
      zv://<project>/<environment>/<KEY>
      zv://<project>/<environment>/<folder>/<KEY>
  project, environment and folder are slugs: lowercase letters, digits and
  single dashes (payments-api, staging, stripe). KEY is the variable name
  (STRIPE_SECRET_KEY), letters, digits and _, not starting with a digit.
  One secret has one value per environment. Folders are one level deep and
  shared by all of a project's environments. An environment can fall back to
  another ("inherits"): a secret with no value there uses the other's value.
  Places (for ls, env, --env-from): zv://project, zv://project/env,
  zv://project/env/folder/

WHO IS ASKING, AND APPROVALS
  Two ways to run zv:
  * As the person (no --agent): every command is approved in the Zvault app,
    unless the terminal ran `zv signin` (reads only, up to an hour).
  * As a paired agent (--agent "Claude Code", or ZV_AGENT="Claude Code"): reads
    are limited to the places the person allowed in Zvault > Agents, with the
    approval mode they chose. Pair once with: zv agent pair --name "Claude Code"
  Every change (create, rename, delete, set, item) always runs as the person
  and always shows an approval in Zvault, even after `zv signin`. Tell the
  person to look at the app when you run one. It waits up to 90 seconds.
  Deletes also need --yes on the command line.

FIRST STEPS
  zv status                          Is Zvault running and unlocked?
  zv projects                        Projects, environments, folders (names only)
  zv ls -r zv://payments-api         Every secret path in a project (no values)

SET UP A PROJECT
  zv project create "Payments API" --env Development --env Staging --env Production
  zv environment create zv://payments-api QA --inherits staging
  zv folder create zv://payments-api Stripe
  zv project rename zv://payments-api "Payments" --slug payments
  zv environment edit zv://payments-api/qa --name "Quality" --no-inherit

STORE SECRETS (values go through stdin, never as an argument)
  printf '%s' "$VALUE" | zv set zv://payments-api/staging/DATABASE_URL
  zv set zv://payments-api/production/SESSION_SECRET --generate 48
      makes a random value inside zv and saves it without printing it; use it
      whenever the person wants a new secret, so you never see the value
  openssl rand -hex 32 | zv set zv://payments-api/development/API_TOKEN
  zv set creates the secret if it is new. The project and environment must
  exist (and the folder, if the path has one).

USE SECRETS WITHOUT SEEING THEM (preferred)
  zv run --agent "Claude Code" --env DATABASE_URL=zv://payments-api/staging/DATABASE_URL -- npm test
  zv run --agent "Claude Code" --env-from zv://payments-api/development -- npm run dev
      values go only into that command's environment and are masked in its output
  eval "$(zv env zv://payments-api/development --format shell)"   (a person's own shell)

READ A VALUE (only when the person asks you to)
  zv read zv://payments-api/staging/DATABASE_URL
  zv copy zv://payments-api/staging/DATABASE_URL    (to the clipboard; you never see it)

DELETE
  zv rm zv://payments-api/staging/DATABASE_URL --yes                    that environment's value
  zv rm zv://payments-api/staging/DATABASE_URL --all-environments --yes the whole secret
  zv folder delete zv://payments-api stripe --yes                       (must be empty)
  zv environment delete zv://payments-api/qa --yes                      with every value in it
  zv project delete zv://payments-api --yes                             with everything in it
  Only delete when the person clearly asked for it. There is no undo.

LOGINS IN THE PERSONAL VAULT (zv item)
  zv item list                                   titles, usernames, websites; no passwords
  zv item create --title GitHub --username me@example.com --url https://github.com --generate
  printf '%s' "$PW" | zv item create --title Bank --username me --password-stdin
  zv item get GitHub --field username            one field; password, otp, url, notes, totp, id
  zv item edit GitHub --generate 40              rotate the password
  zv item delete GitHub --yes
  Items are found by title (any case) or by the id `zv item list` shows.

MACHINE-READABLE OUTPUT
  zv projects --json, zv environment list zv://p --json, zv folder list zv://p --json,
  zv ls --json, zv item list --json, zv item get NAME --json, zv status --json

EXIT CODES
  0 done   1 failed (the message says why)   2 Zvault not running
  3 agent not paired   4 denied, not allowed, or nobody answered
  5 Zvault locked      64 wrong usage        127 the command for zv run was not found
  On 2 or 5 ask the person to open or unlock Zvault (or run `zv unlock`).
  On 4 do not retry in a loop; ask the person what they want.

MORE
  zv --help, and zv <command> --help for every command and its examples.
"#;
