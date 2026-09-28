//! The browser extension: which saved logins belong to a page, what a fill
//! hands back, and the framing Chrome uses to talk to a native messaging host.
//!
//! The extension never holds a key. It asks `zv`, which Chrome starts as the
//! native messaging host, and `zv` asks the app over the agent socket like
//! any paired agent. The app decides which logins a page may see by matching
//! the page's address against each login's saved websites here, in Rust, on
//! the decrypted item: the extension's own view of the page is not trusted
//! for that.

use std::io::{Read, Write};
use std::net::IpAddr;

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

/// The native messaging host's name, as the extension calls it.
pub const HOST_NAME: &str = "com.zvault.browser";

/// The extension's id, fixed by the public `key` in its `manifest.json`.
pub const EXTENSION_ID: &str = "koohciaalhgmbjmpnenehibgcfndkgdf";

/// Chrome refuses messages from a host larger than this.
pub const MAX_TO_BROWSER: usize = 1024 * 1024;
/// We refuse messages from the extension larger than this; real ones are a
/// few hundred bytes.
pub const MAX_FROM_BROWSER: usize = 64 * 1024;

/// The origin Chrome passes to the host as its first argument.
pub fn extension_origin() -> String {
    format!("chrome-extension://{EXTENSION_ID}/")
}

/// A login the page may offer to fill: never its password or one-time code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginInfo {
    pub id: String,
    pub title: String,
    pub username: String,
    /// The saved website that matched the page.
    pub url: String,
    pub has_totp: bool,
}

/// What a fill hands the extension.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FillContents {
    pub username: String,
    /// Empty when only the one-time code was asked for.
    pub password: Zeroizing<String>,
    /// The current one-time code, when the item has one.
    #[serde(default)]
    pub otp: Option<String>,
    /// Seconds until that code changes.
    #[serde(default)]
    pub otp_remaining: Option<u64>,
}

/// Whether a login typed into a page is already in Zvault. The extension
/// uses it to decide whether to offer saving; it never carries a password.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum SaveCheck {
    /// No login with this user name is saved for the site.
    New,
    /// A login with this user name is saved for the site with a different
    /// password.
    #[serde(rename_all = "camelCase")]
    Update { item: String, title: String },
    /// This exact login is already saved.
    Saved,
}

/// The longest user name and password the extension may offer to save.
pub const MAX_SAVE_USERNAME: usize = 512;
pub const MAX_SAVE_PASSWORD: usize = 1024;

/// Hosts shared by many unrelated sites: a login saved for one of these fills
/// only on that exact host, never on its subdomains.
const SHARED_HOSTS: &[&str] = &[
    "github.io",
    "gitlab.io",
    "pages.dev",
    "workers.dev",
    "vercel.app",
    "netlify.app",
    "herokuapp.com",
    "azurewebsites.net",
    "cloudfront.net",
    "amazonaws.com",
    "appspot.com",
    "web.app",
    "firebaseapp.com",
    "blogspot.com",
    "sslip.io",
    "nip.io",
    "ngrok.io",
    "ngrok-free.app",
    "co.uk",
    "org.uk",
    "co.in",
    "co.jp",
    "com.au",
    "com.br",
    "eu.org",
];

#[derive(Debug, PartialEq, Eq)]
struct Site {
    https: bool,
    host: String,
    port: Option<u16>,
}

fn parse(url: &str, default_https: bool) -> Option<Site> {
    let url = url.trim();
    let parsed = if url.contains("://") {
        url::Url::parse(url).ok()?
    } else if default_https {
        // Logins are often saved as just "github.com".
        url::Url::parse(&format!("https://{url}")).ok()?
    } else {
        return None;
    };
    let https = match parsed.scheme() {
        "https" => true,
        "http" => false,
        _ => return None,
    };
    let host = parsed
        .host_str()?
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_owned();
    if host.is_empty() {
        return None;
    }
    Some(Site {
        https,
        host,
        port: parsed.port(),
    })
}

fn is_ip(host: &str) -> bool {
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
        .is_ok()
}

/// Whether a login saved for `saved` may be filled on the page at `page`.
///
/// The hosts must be the same (ignoring `www.`), or the page must be on a
/// subdomain of the saved host (`github.com` fills on `gist.github.com`, not
/// the other way round). Hosts shared by many sites, IP addresses and
/// single-label names like `localhost` match only exactly. A login saved for
/// `https` never fills on a plain `http` page, and explicit ports must agree.
pub fn matches(saved: &str, page: &str) -> bool {
    let (Some(saved), Some(page)) = (parse(saved, true), parse(page, false)) else {
        return false;
    };
    if saved.https && !page.https {
        return false;
    }
    if saved.port != page.port {
        return false;
    }
    if saved.host == page.host {
        return true;
    }
    let subdomain_ok = saved.host.contains('.')
        && !is_ip(&saved.host)
        && !SHARED_HOSTS.contains(&saved.host.as_str());
    subdomain_ok
        && page
            .host
            .strip_suffix(&saved.host)
            .is_some_and(|rest| rest.ends_with('.'))
}

/// The first of `saved` that may be filled on `page`.
pub fn first_match<'a>(saved: &'a [String], page: &str) -> Option<&'a str> {
    saved.iter().map(String::as_str).find(|s| matches(s, page))
}

/// The page's host, for prompts and the activity log.
pub fn host_of(page: &str) -> Option<String> {
    parse(page, false).map(|s| s.host)
}

/// The website a new login from `page` is saved for: its scheme, host
/// (without `www.`) and port, like `https://github.com`.
pub fn site_of(page: &str) -> Option<String> {
    let site = parse(page, false)?;
    let scheme = if site.https { "https" } else { "http" };
    Some(match site.port {
        Some(port) => format!("{scheme}://{}:{port}", site.host),
        None => format!("{scheme}://{}", site.host),
    })
}

#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("message too large")]
    TooLarge,
}

/// Reads one native messaging frame: a 32-bit length in native byte order,
/// then that many bytes of JSON. `Ok(None)` when the browser closed stdin.
pub fn read_frame(r: &mut impl Read) -> Result<Option<Zeroizing<Vec<u8>>>, FrameError> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let len = u32::from_ne_bytes(len) as usize;
    if len > MAX_FROM_BROWSER {
        return Err(FrameError::TooLarge);
    }
    let mut buf = Zeroizing::new(vec![0u8; len]);
    r.read_exact(&mut buf)?;
    Ok(Some(buf))
}

/// Writes one native messaging frame.
pub fn write_frame(w: &mut impl Write, json: &[u8]) -> Result<(), FrameError> {
    if json.len() > MAX_TO_BROWSER {
        return Err(FrameError::TooLarge);
    }
    let len = u32::try_from(json.len()).map_err(|_| FrameError::TooLarge)?;
    w.write_all(&len.to_ne_bytes())?;
    w.write_all(json)?;
    w.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    #[test]
    fn same_site_and_subdomains_match() {
        assert!(matches("https://github.com", "https://github.com/login"));
        assert!(matches("github.com", "https://github.com/login"));
        assert!(matches("https://www.github.com", "https://github.com/"));
        assert!(matches("https://github.com", "https://www.github.com/"));
        assert!(matches("github.com", "https://gist.github.com/"));
        assert!(matches("GitHub.com", "https://GITHUB.COM./session"));
        // Saved for http, the https page is the same site, upgraded.
        assert!(matches(
            "http://intranet.example",
            "https://intranet.example/"
        ));
    }

    #[test]
    fn other_sites_do_not_match() {
        assert!(!matches("github.com", "https://github.com.evil.io/"));
        assert!(!matches("github.com", "https://notgithub.com/"));
        assert!(!matches("gist.github.com", "https://github.com/"));
        assert!(!matches("login.example.com", "https://evil.example.com/"));
        assert!(!matches("github.com", "chrome://settings"));
        assert!(!matches("github.com", "file:///etc/passwd"));
        assert!(!matches("", "https://github.com/"));
        assert!(!matches("javascript:alert(1)", "https://github.com/"));
        // The page address must be a full URL; a bare host is not a page.
        assert!(!matches("github.com", "github.com"));
    }

    #[test]
    fn https_logins_never_fill_on_http() {
        assert!(!matches("https://github.com", "http://github.com/login"));
        assert!(!matches("github.com", "http://github.com/login"));
        assert!(matches(
            "http://localhost:3000",
            "http://localhost:3000/login"
        ));
    }

    #[test]
    fn ports_must_agree() {
        assert!(!matches("http://localhost:3000", "http://localhost:4000/"));
        assert!(!matches("https://example.com", "https://example.com:8443/"));
        assert!(matches(
            "https://example.com:8443",
            "https://example.com:8443/x"
        ));
    }

    #[test]
    fn shared_hosts_ips_and_bare_names_match_only_exactly() {
        assert!(!matches("github.io", "https://someone.github.io/"));
        assert!(matches(
            "https://someone.github.io",
            "https://someone.github.io/app"
        ));
        assert!(!matches(
            "https://someone.github.io",
            "https://other.github.io/"
        ));
        assert!(!matches("co.uk", "https://bank.co.uk/"));
        assert!(!matches("http://localhost", "http://a.localhost/"));
        assert!(matches("http://192.168.1.10", "http://192.168.1.10/"));
        assert!(!matches("http://1.10", "http://192.168.1.10/"));
        assert!(!matches("sslip.io", "https://52-66-189-120.sslip.io/"));
    }

    #[test]
    fn first_match_picks_the_matching_website() {
        let saved = vec!["https://example.org".to_owned(), "github.com".to_owned()];
        assert_eq!(
            first_match(&saved, "https://github.com/"),
            Some("github.com")
        );
        assert_eq!(first_match(&saved, "https://gitlab.com/"), None);
        assert_eq!(
            host_of("https://www.GitHub.com/x").as_deref(),
            Some("github.com")
        );
    }

    #[test]
    fn a_new_login_is_saved_for_the_page_s_site() {
        let site = site_of("https://www.GitHub.com/login?x=1").unwrap();
        assert_eq!(site, "https://github.com");
        assert!(matches(&site, "https://github.com/session"));
        assert_eq!(
            site_of("http://localhost:3000/signin").as_deref(),
            Some("http://localhost:3000")
        );
        assert_eq!(site_of("chrome://settings"), None);
        assert_eq!(
            serde_json::to_value(SaveCheck::Update {
                item: "i1".into(),
                title: "GitHub".into()
            })
            .unwrap(),
            serde_json::json!({"state": "update", "item": "i1", "title": "GitHub"})
        );
    }

    #[test]
    fn frames_round_trip_and_refuse_oversized_input() {
        let mut buf = Vec::new();
        write_frame(&mut buf, br#"{"id":1}"#).unwrap();
        assert_eq!(&buf[..4], &8u32.to_ne_bytes());
        let mut r = Cursor::new(buf);
        assert_eq!(
            read_frame(&mut r).unwrap().unwrap().as_slice(),
            br#"{"id":1}"#
        );
        assert!(read_frame(&mut r).unwrap().is_none());

        let mut big = u32::try_from(MAX_FROM_BROWSER + 1)
            .unwrap()
            .to_ne_bytes()
            .to_vec();
        big.extend(std::iter::repeat_n(b' ', 8));
        assert!(matches!(
            read_frame(&mut Cursor::new(big)),
            Err(FrameError::TooLarge)
        ));
        assert!(write_frame(&mut Vec::new(), &vec![b' '; MAX_TO_BROWSER + 1]).is_err());
    }
}
