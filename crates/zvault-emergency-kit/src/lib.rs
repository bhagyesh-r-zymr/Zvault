//! The Zvault Emergency Kit: a one-page PDF with everything needed to sign in
//! on a new device, rendered entirely on the user's device.
//!
//! The kit carries the sign-in address, the account email and the full Secret
//! Key, plus an empty box for the person to write their master password by
//! hand. The Secret Key is never sent to the server, so this document is the
//! only copy outside the device's keychain.
//!
//! The PDF is written by hand rather than through a PDF library so the whole
//! document stays in one zeroized buffer and no third-party code handles the
//! Secret Key. It uses only the 14 standard PDF fonts, so nothing is embedded
//! and the file opens in any viewer.

mod date;
mod pdf;
mod read;

use core::fmt::Write as _;

use zeroize::Zeroizing;
use zvault_crypto::SecretKey;

pub use date::Date;
pub use read::{MAX_KIT_BYTES, ReadKit, read};

/// Suggested file name for the save dialog.
pub const FILE_NAME: &str = "Zvault Emergency Kit.pdf";

const MAX_EMAIL_LEN: usize = 254;
const MAX_URL_LEN: usize = 200;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Error {
    #[error("the email address can't be printed on the Emergency Kit")]
    InvalidEmail,
    #[error("the sign-in address must be an https URL")]
    InvalidSignInUrl,
}

/// What goes on the kit.
pub struct Kit<'a> {
    pub email: &'a str,
    pub sign_in_url: &'a str,
    pub secret_key: &'a SecretKey,
    pub created_on: Date,
}

impl Kit<'_> {
    /// Renders the kit as a PDF. The returned buffer contains the Secret Key
    /// and is wiped when dropped.
    pub fn render(&self) -> Result<Zeroizing<Vec<u8>>, Error> {
        validate_email(self.email)?;
        validate_url(self.sign_in_url)?;
        let key = self.secret_key.to_display_string();
        Ok(pdf::document(&page(self, &key)))
    }
}

fn validate_email(email: &str) -> Result<(), Error> {
    let printable = email.bytes().all(|b| b.is_ascii_graphic());
    let shaped = email
        .split_once('@')
        .is_some_and(|(local, domain)| !local.is_empty() && !domain.is_empty());
    if (3..=MAX_EMAIL_LEN).contains(&email.len()) && printable && shaped {
        Ok(())
    } else {
        Err(Error::InvalidEmail)
    }
}

fn validate_url(url: &str) -> Result<(), Error> {
    let host = url.strip_prefix("https://").unwrap_or_default();
    if url.len() <= MAX_URL_LEN && !host.is_empty() && url.bytes().all(|b| b.is_ascii_graphic()) {
        Ok(())
    } else {
        Err(Error::InvalidSignInUrl)
    }
}

// A4 in points.
const PAGE_W: f32 = 595.0;
const PAGE_H: f32 = 842.0;
const MARGIN: f32 = 48.0;
const CONTENT_W: f32 = PAGE_W - 2.0 * MARGIN;

/// Courier glyphs are all 0.6 em wide, which lets values wrap exactly.
const COURIER_ADVANCE: f32 = 0.6;
const VALUE_SIZE: f32 = 12.0;
const KEY_SIZE: f32 = 16.0;

const INK: Rgb = Rgb(0.10, 0.12, 0.16);
const MUTED: Rgb = Rgb(0.40, 0.43, 0.48);
const BRAND: Rgb = Rgb(0.09, 0.13, 0.24);
const PANEL: Rgb = Rgb(0.95, 0.96, 0.98);
const RULE: Rgb = Rgb(0.80, 0.82, 0.86);
const WHITE: Rgb = Rgb(1.0, 1.0, 1.0);

const ADVICE: &[&str] = &[
    "Print this page, or keep the file somewhere only you can reach, like an encrypted drive.",
    "Store the printed copy with your important papers, such as your passport or will.",
    "You need your Secret Key and master password to sign in on a new device.",
    "Zvault can't see or reset either of them. If you lose both, your data can't be recovered.",
    "Anyone with this kit and your master password can open your vault, so keep it private.",
];

/// Room for the whole content stream, so it never reallocates and leaves an
/// unzeroized copy of the Secret Key in freed memory.
const PAGE_CAPACITY: usize = 64 * 1024;

fn page(kit: &Kit<'_>, key: &str) -> Zeroizing<String> {
    let mut p = Page {
        ops: Zeroizing::new(String::with_capacity(PAGE_CAPACITY)),
    };

    // Header band.
    p.fill_rect(BRAND, 0.0, PAGE_H - 84.0, PAGE_W, 84.0);
    p.text(
        Font::Bold,
        24.0,
        WHITE,
        MARGIN,
        PAGE_H - 46.0,
        "Zvault Emergency Kit",
    );
    p.text(
        Font::Regular,
        10.0,
        Rgb(0.78, 0.82, 0.90),
        MARGIN,
        PAGE_H - 66.0,
        "Your way back into your account. Keep it safe and keep it private.",
    );

    let mut y = PAGE_H - 124.0;

    y = p.field(y, "SIGN-IN ADDRESS", kit.sign_in_url);
    y = p.field(y, "EMAIL", kit.email);

    // Secret Key panel.
    p.label(y, "SECRET KEY");
    let panel_h = 44.0;
    let panel_top = y - 10.0;
    p.fill_rect(PANEL, MARGIN, panel_top - panel_h, CONTENT_W, panel_h);
    p.stroke_rect(RULE, MARGIN, panel_top - panel_h, CONTENT_W, panel_h);
    p.text(
        Font::MonoBold,
        KEY_SIZE,
        INK,
        MARGIN + 14.0,
        panel_top - 28.0,
        key,
    );
    y = panel_top - panel_h - 16.0;
    p.text(
        Font::Regular,
        9.0,
        MUTED,
        MARGIN,
        y,
        "Created on this device and never sent to Zvault. Letters are not case sensitive.",
    );
    y -= 32.0;

    // Master password write-in box.
    p.label(y, "MASTER PASSWORD");
    let box_h = 40.0;
    let box_top = y - 10.0;
    p.stroke_rect(RULE, MARGIN, box_top - box_h, CONTENT_W, box_h);
    y = box_top - box_h - 16.0;
    p.text(
        Font::Regular,
        9.0,
        MUTED,
        MARGIN,
        y,
        "Write it by hand after printing. Never type it into this file.",
    );
    y -= 30.0;

    p.hline(RULE, y);
    y -= 28.0;

    p.text(Font::Bold, 13.0, INK, MARGIN, y, "What to do with this kit");
    y -= 22.0;
    for line in ADVICE {
        p.bullet(y, line);
        y -= 18.0;
    }

    let mut footer = String::from("Created on ");
    kit.created_on.write_long(&mut footer);
    p.text(Font::Regular, 8.0, MUTED, MARGIN, 36.0, &footer);

    assert!(
        p.ops.capacity() == PAGE_CAPACITY,
        "Emergency Kit content stream outgrew its buffer"
    );
    p.ops
}

#[derive(Clone, Copy)]
struct Rgb(f32, f32, f32);

#[derive(Clone, Copy)]
enum Font {
    Regular,
    Bold,
    Mono,
    MonoBold,
}

impl Font {
    fn resource(self) -> &'static str {
        match self {
            Font::Regular => "/F1",
            Font::Bold => "/F2",
            Font::Mono => "/F3",
            Font::MonoBold => "/F4",
        }
    }
}

/// A page content stream. It may hold the Secret Key, so it lives in a
/// zeroizing buffer and is written in place (no temporary strings).
#[derive(Default)]
struct Page {
    ops: Zeroizing<String>,
}

impl Page {
    fn fill_rect(&mut self, c: Rgb, x: f32, y: f32, w: f32, h: f32) {
        let _ = writeln!(
            self.ops,
            "q {:.3} {:.3} {:.3} rg {x:.2} {y:.2} {w:.2} {h:.2} re f Q",
            c.0, c.1, c.2
        );
    }

    fn stroke_rect(&mut self, c: Rgb, x: f32, y: f32, w: f32, h: f32) {
        let _ = writeln!(
            self.ops,
            "q {:.3} {:.3} {:.3} RG 0.75 w {x:.2} {y:.2} {w:.2} {h:.2} re S Q",
            c.0, c.1, c.2
        );
    }

    fn hline(&mut self, c: Rgb, y: f32) {
        let _ = writeln!(
            self.ops,
            "q {:.3} {:.3} {:.3} RG 0.75 w {MARGIN:.2} {y:.2} m {:.2} {y:.2} l S Q",
            c.0,
            c.1,
            c.2,
            PAGE_W - MARGIN
        );
    }

    /// Draws one line of text. `s` must be printable ASCII (checked by the
    /// callers' validation); the bullet byte is added separately.
    fn text(&mut self, font: Font, size: f32, c: Rgb, x: f32, y: f32, s: &str) {
        self.text_bytes(font, size, c, x, y, s.as_bytes());
    }

    fn text_bytes(&mut self, font: Font, size: f32, c: Rgb, x: f32, y: f32, s: &[u8]) {
        let _ = write!(
            self.ops,
            "BT {} {size:.1} Tf {:.3} {:.3} {:.3} rg {x:.2} {y:.2} Td (",
            font.resource(),
            c.0,
            c.1,
            c.2
        );
        pdf::escape_into(&mut self.ops, s);
        self.ops.push_str(") Tj ET\n");
    }

    fn label(&mut self, y: f32, s: &str) {
        self.text(Font::Bold, 8.5, MUTED, MARGIN, y, s);
    }

    /// A label with a monospaced value under it, wrapped to the content width.
    /// Returns the y for the next block.
    fn field(&mut self, y: f32, label: &str, value: &str) -> f32 {
        self.label(y, label);
        let per_line = (CONTENT_W / (VALUE_SIZE * COURIER_ADVANCE)) as usize;
        let mut y = y - 18.0;
        for chunk in value.as_bytes().chunks(per_line) {
            self.text_bytes(Font::Mono, VALUE_SIZE, INK, MARGIN, y, chunk);
            y -= VALUE_SIZE + 3.0;
        }
        y - 18.0
    }

    fn bullet(&mut self, y: f32, s: &str) {
        // 0x95 is the bullet in WinAnsiEncoding.
        self.text_bytes(Font::Regular, 10.0, INK, MARGIN, y, &[0x95]);
        self.text(Font::Regular, 10.0, INK, MARGIN + 12.0, y, s);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "Z1-ABC123-DEFGH-JKMNP-QRSTV-WXYZ0-12345";

    fn render(email: &str, url: &str) -> Result<Zeroizing<Vec<u8>>, Error> {
        let key = SecretKey::parse(KEY).unwrap();
        Kit {
            email,
            sign_in_url: url,
            secret_key: &key,
            created_on: Date::new(2026, 9, 24).unwrap(),
        }
        .render()
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|w| w == needle)
    }

    #[test]
    fn prints_the_key_email_url_and_date() {
        let pdf = render("ada@example.com", "https://my.zvault.app").unwrap();
        assert!(pdf.starts_with(b"%PDF-1.7\n"));
        assert!(pdf.ends_with(b"%%EOF\n"));
        for needle in [
            KEY,
            "(ada@example.com)",
            "(https://my.zvault.app)",
            "Created on 24 September 2026",
        ] {
            assert!(contains(&pdf, needle.as_bytes()), "missing {needle}");
        }
    }

    #[test]
    fn keeps_the_key_out_of_metadata() {
        let pdf = render("ada@example.com", "https://my.zvault.app").unwrap();
        let text = String::from_utf8_lossy(&pdf);
        let info = &text[text.find("/Producer").unwrap()..];
        let info = &info[..info.find(">>").unwrap()];
        assert!(!info.contains("ABC123"));
        assert!(!info.contains("ada@"));
    }

    #[test]
    fn xref_offsets_point_at_their_objects() {
        let pdf = render("ada@example.com", "https://my.zvault.app").unwrap();
        // Offsets are byte positions, so parse the raw bytes, not a decoded string.
        let ascii = |range: &[u8]| core::str::from_utf8(range).unwrap().to_owned();
        let trailer = ascii(&pdf[pdf.len() - 64..]);
        let startxref: usize = trailer
            .rsplit("startxref\n")
            .next()
            .and_then(|s| s.lines().next())
            .unwrap()
            .parse()
            .unwrap();
        let xref = ascii(&pdf[startxref..]);
        assert!(xref.starts_with("xref\n"));
        let entries: Vec<&str> = xref
            .lines()
            .skip(3)
            .take_while(|l| l.ends_with(" n "))
            .collect();
        assert_eq!(entries.len(), pdf::OBJECT_COUNT);
        for (i, entry) in entries.iter().enumerate() {
            assert_eq!(entry.len(), 19, "entries are 20 bytes with the newline");
            let offset: usize = entry[..10].parse().unwrap();
            assert!(pdf[offset..].starts_with(format!("{} 0 obj", i + 1).as_bytes()));
        }
    }

    #[test]
    fn long_emails_wrap_instead_of_running_off_the_page() {
        let email = format!("{}@example.com", "a".repeat(100));
        let pdf = render(&email, "https://my.zvault.app").unwrap();
        assert!(!contains(&pdf, email.as_bytes()));
        assert!(contains(&pdf, "a".repeat(69).as_bytes()));
    }

    #[test]
    fn escapes_pdf_string_delimiters() {
        let pdf = render("we(i)rd\\@example.com", "https://my.zvault.app").unwrap();
        assert!(contains(&pdf, br"(we\(i\)rd\\@example.com)"));
    }

    #[test]
    fn rejects_values_it_cannot_print_safely() {
        for email in [
            "",
            "a@",
            "@b",
            "no-at-sign",
            "sp ace@example.com",
            "zoë@example.com",
        ] {
            assert_eq!(
                render(email, "https://my.zvault.app").unwrap_err(),
                Error::InvalidEmail,
                "{email}"
            );
        }
        for url in [
            "http://my.zvault.app",
            "https://",
            "my.zvault.app",
            "https://a b",
        ] {
            assert_eq!(
                render("ada@example.com", url).unwrap_err(),
                Error::InvalidSignInUrl,
                "{url}"
            );
        }
    }

    #[test]
    fn content_fits_on_the_page() {
        // The longest prose line in 10pt Helvetica must stay inside the margins.
        // Helvetica averages well under 0.5 em per character for this text.
        for line in ADVICE {
            assert!(line.len() as f32 * 10.0 * 0.5 <= CONTENT_W - 12.0, "{line}");
        }
        let key_width = KEY.len() as f32 * KEY_SIZE * COURIER_ADVANCE;
        assert!(key_width + 28.0 <= CONTENT_W);
    }
}
