# `zv`: secrets for local agents

`zv` lets coding agents (Claude Code, Cursor, CI scripts on your Mac) use
secrets you approved in Zvault, without ever holding your master password or a
vault key.

```sh
zv agent pair --name "Claude Code"      # approve in Zvault; code shown in both places
zv run --env DATABASE_URL=zv://web/dev/db-url -- npm test
zv read zv://web/dev/stripe#secret     # prints one value
zv agent status                        # what this agent may use
zv agent unpair
```

## References

`zv://<project>/<environment>/[<folder>/]<item>[#<field>]`. Folders are one
level deep, so three segments mean no folder and four mean a folder. The field
defaults to `password`; `username`, `notes`, `title` and `url` also work today.
Segments are `A-Z a-z 0-9 . _ -` and compare case-insensitively.

An agent's scopes are references (an item, or one field of it) or prefixes
ending in `/*`: `zv://web/*`, `zv://web/dev/*`, `zv://web/dev/payments/*`.

## How a request is decided

1. `zv` connects to `agent.sock` in the app's data directory
   (`~/Library/Application Support/com.zvault.desktop/`, or `$ZV_SOCKET`). The
   directory is `0700`, the socket `0600`, and the app checks the peer runs as
   the same user (`getpeereid` on macOS, `SO_PEERCRED` on Linux).
2. `zv` sends the agent's bearer token (in the login Keychain on macOS). The app
   stores only its SHA-256 and compares in constant time.
3. The app checks, in order: paused, every reference inside the agent's scopes,
   Zvault unlocked, then the approval mode:
   - **Ask every time**: a prompt in the app, then Touch ID when Touch ID
     unlock is set up.
   - **15-minute session**: one approval covers the same references for 15
     minutes.
   - **While unlocked**: no prompt; locking Zvault ends it.

   Locking Zvault or changing an agent's settings ends every session approval
   and withdraws open prompts.
4. The UI returns the encrypted item for each reference; Rust decrypts it. No
   secret value passes through the web view.
5. The use or denial is written to the agent's activity log (references and
   outcome only, never values) and the values go back over the socket.

`zv run` sets the values only in the child's environment and replaces them with
`********` in its stdout and stderr (values under 4 characters are not
masked). `--no-mask` hands the child the terminal instead.

Exit codes: the child's own code for `zv run`; 2 Zvault not reachable, 3 not
paired, 4 denied / out of scope / paused / timed out, 5 locked, 64 usage.

## Code

- `crates/zvault-agent`: reference format, wire protocol, policy, activity
  log, output masking. No I/O beyond reading a line.
- `crates/zvault-cli`: the `zv` binary.
- `apps/desktop/src-tauri/src/agents.rs`: socket server and Tauri commands.
- `apps/desktop/src/agents/api.ts`: typed bridge for the Agents screen.
