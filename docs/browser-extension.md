# Browser extension

The Zvault extension fills logins and 2FA codes in Chrome, Brave, Edge, Arc,
Vivaldi and Chromium. It holds no keys: every login comes from the Zvault app
on the same Mac, which decides what the extension may see.

Safari is not supported yet; it needs an Apple Developer signing identity.

## Install

1. Install Zvault for Mac (v0.1.8 or later) and open it once. On every launch
   it registers its bundled `zv` with each Chrome-family browser it finds.
2. Download `zvault-chrome-extension.zip` from the
   [latest release](https://github.com/bhagyesh-r-zymr/Zvault/releases/latest/download/zvault-chrome-extension.zip)
   and unzip it.
3. Open `chrome://extensions`, turn on **Developer mode**, choose **Load
   unpacked** and pick the unzipped folder.
4. Click the Zvault toolbar button, then **Connect to Zvault**. Zvault shows
   the same six-digit code; check it and choose **Connect browser**.

To build it yourself: `pnpm --filter @zvault/extension build`, then load
`apps/extension/dist`.

## Using it

- Click into a login field and press the small Zvault button in it, or open
  the toolbar popup and press **Fill**. `⌘⇧L` fills the only login saved for
  the page, or opens the popup when there are several.
- On the next page, the button in a code field (or the row of code boxes)
  fills the current one-time code, with the login you just used first. The
  popup's **Code** button copies it instead.
- The browser shows up under **Agents** in Zvault, where you can pause it,
  make every fill ask with Touch ID, see each fill in its activity, or unpair
  it.

## How it works

```
page ── content script ── service worker ── zv (native host) ── agent.sock ── Zvault app
```

- Chrome starts `zv` as the native messaging host `com.zvault.browser`. The
  host manifest Zvault writes lets only this extension
  (`koohciaalhgmbjmpnenehibgcfndkgdf`, fixed by the `key` in `manifest.json`)
  start it.
- `zv` turns each message into a request on the same socket `zv` commands
  use ([agent-cli.md](agent-cli.md)). Pairing gives the extension a token,
  stored like an agent's (the login Keychain on macOS) in a separate list.
  The app keeps only its hash.
- The paired browser is an agent with no `zv://` scopes: it cannot read
  project secrets. It can ask for two things: the logins saved for a page
  (titles and user names only) and one login's fill.
- The page address comes from the browser (the frame's own URL and its tab's
  URL), never from the page. A login is listed or filled only when one of its
  saved websites matches both; a login form framed inside another site gets
  nothing. The fill check runs in Rust on the decrypted item.
- Matching: the same host (ignoring `www.`) or a subdomain of the saved host
  (`github.com` fills on `gist.github.com`, never the reverse). Hosts shared by
  many sites (`github.io`, `vercel.app`, `co.uk`…), IP addresses and single
  names like `localhost` match only exactly. A login saved for `https` never
  fills on an `http` page, and explicit ports must agree. See
  `crates/zvault-agent/src/browser.rs`.
- While Zvault is locked or the browser is paused, requests fail without a
  prompt and the extension offers to bring Zvault forward. In "Ask me each
  time" mode every fill shows a prompt with Touch ID.
- The in-page button and menu live in a closed shadow root and act only on
  real clicks, so the page cannot read or drive them.
