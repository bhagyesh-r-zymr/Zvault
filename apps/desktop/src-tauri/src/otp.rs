//! One-time passwords for vault items: reading a setup QR code from the
//! screen or an image file, checking pasted or typed keys, and producing the
//! current code. The item itself stores the canonical `otpauth://` URI (see
//! `ItemFields::totp` in `vault.rs`); codes are computed from it here.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::DialogExt;
use zeroize::Zeroizing;
use zvault_otp::Totp;

/// Largest image decoded when looking for a QR code (pixels per side).
const MAX_IMAGE_SIDE: u32 = 8_000;

/// A code as the UI shows it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OtpCode {
    pub code: String,
    pub period: u64,
    /// Seconds until the next code.
    pub remaining: u64,
}

impl OtpCode {
    pub fn now(totp: &Totp) -> Self {
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        let c = totp.code_at(secs);
        Self {
            code: c.code,
            period: c.period,
            remaining: c.remaining,
        }
    }
}

/// What the editor shows after a scan or paste, before the item is saved.
/// `uri` is what goes into the item's `totp` field.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OtpSetup {
    uri: String,
    issuer: String,
    account: String,
    current: OtpCode,
}

impl OtpSetup {
    fn from_totp(totp: &Totp) -> Self {
        Self {
            uri: totp.to_uri().to_string(),
            issuer: totp.issuer().to_owned(),
            account: totp.account().to_owned(),
            current: OtpCode::now(totp),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ScanError {
    #[error("No QR code was found. Make sure the whole code is visible and try again.")]
    NoQrCode,
    #[error("That QR code isn't a one-time password setup code.")]
    NotOtp,
    #[error("That image couldn't be read.")]
    Image,
    #[error("Scanning the screen is only available on macOS.")]
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    Unsupported,
    #[error("{0}")]
    Otp(#[from] zvault_otp::OtpError),
}

impl Serialize for ScanError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Checks a pasted `otpauth://` link or typed setup key.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn otp_parse(input: String) -> Result<OtpSetup, ScanError> {
    let input = Zeroizing::new(input);
    Ok(OtpSetup::from_totp(&Totp::parse(&input)?))
}

/// Lets the person pick an image (a screenshot of a setup page, say) and reads
/// the QR code in it. Resolves to None if they cancel.
#[tauri::command]
pub async fn otp_scan_image<R: Runtime>(app: AppHandle<R>) -> Result<Option<OtpSetup>, ScanError> {
    // Async commands run off the main thread, so blocking on the dialog is safe.
    let Some(file) = app
        .dialog()
        .file()
        .set_title("Choose an image of the QR code")
        .add_filter("Images", &["png", "jpg", "jpeg", "gif", "bmp", "webp"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|_| ScanError::Image)?;
    tauri::async_runtime::spawn_blocking(move || scan_file(&path).map(Some))
        .await
        .map_err(|_| ScanError::Image)?
}

/// Lets the person drag a box around a QR code anywhere on screen, like
/// 1Password's "Scan QR code". Resolves to None if they press Escape.
#[tauri::command]
pub async fn otp_scan_screen() -> Result<Option<OtpSetup>, ScanError> {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(shot) = capture_screen_region()? else {
            return Ok(None);
        };
        let result = scan_file(shot.path());
        drop(shot);
        result.map(Some)
    })
    .await
    .map_err(|_| ScanError::Image)?
}

fn scan_file(path: &Path) -> Result<OtpSetup, ScanError> {
    let image = image::ImageReader::open(path)
        .and_then(image::ImageReader::with_guessed_format)
        .map_err(|_| ScanError::Image)?;
    let (w, h) = image.into_dimensions().map_err(|_| ScanError::Image)?;
    if w > MAX_IMAGE_SIDE || h > MAX_IMAGE_SIDE {
        return Err(ScanError::Image);
    }
    let image = image::ImageReader::open(path)
        .and_then(image::ImageReader::with_guessed_format)
        .map_err(|_| ScanError::Image)?
        .decode()
        .map_err(|_| ScanError::Image)?
        .to_luma8();
    let text = decode_qr(&image)?;
    otp_from_qr_text(&text)
}

fn decode_qr(image: &image::GrayImage) -> Result<Zeroizing<String>, ScanError> {
    let mut prepared = rqrr::PreparedImage::prepare_from_greyscale(
        image.width() as usize,
        image.height() as usize,
        |x, y| image.get_pixel(x as u32, y as u32).0[0],
    );
    let grids = prepared.detect_grids();
    let mut found = false;
    for grid in grids {
        found = true;
        if let Ok((_, text)) = grid.decode() {
            let text = Zeroizing::new(text);
            if text
                .trim_start()
                .to_ascii_lowercase()
                .starts_with("otpauth://")
            {
                return Ok(text);
            }
        }
    }
    Err(if found {
        ScanError::NotOtp
    } else {
        ScanError::NoQrCode
    })
}

fn otp_from_qr_text(text: &str) -> Result<OtpSetup, ScanError> {
    Ok(OtpSetup::from_totp(&Totp::parse(text)?))
}

/// A screenshot on disk, deleted when dropped.
struct TempShot(PathBuf);

impl TempShot {
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempShot {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Runs macOS's interactive screenshot tool (the Cmd-Shift-4 crosshair) and
/// returns the captured region, or None if it was cancelled.
#[cfg(target_os = "macos")]
fn capture_screen_region() -> Result<Option<TempShot>, ScanError> {
    let path = std::env::temp_dir().join(format!("zvault-qr-{}.png", uuid::Uuid::new_v4()));
    let shot = TempShot(path);
    // -i: interactive selection, -x: no sound, -o: no window shadow.
    let status = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-i", "-x", "-o", "-t", "png"])
        .arg(shot.path())
        .status()
        .map_err(|_| ScanError::Image)?;
    if !status.success() || !shot.path().exists() {
        return Ok(None);
    }
    Ok(Some(shot))
}

#[cfg(not(target_os = "macos"))]
fn capture_screen_region() -> Result<Option<TempShot>, ScanError> {
    Err(ScanError::Unsupported)
}

#[cfg(test)]
mod tests {
    use super::*;

    const URI: &str =
        "otpauth://totp/Microsoft:alice%40contoso.com?secret=JBSWY3DPEHPK3PXP&issuer=Microsoft";

    /// Renders `text` as a QR code image with a quiet zone, the way a setup page shows it.
    fn qr_image(text: &str) -> image::GrayImage {
        let code = qrcode::QrCode::new(text.as_bytes()).unwrap();
        code.render::<image::Luma<u8>>()
            .quiet_zone(true)
            .module_dimensions(6, 6)
            .build()
    }

    #[test]
    fn reads_a_setup_qr_code() {
        let text = decode_qr(&qr_image(URI)).unwrap();
        let setup = otp_from_qr_text(&text).unwrap();
        assert_eq!(setup.issuer, "Microsoft");
        assert_eq!(setup.account, "alice@contoso.com");
        assert_eq!(setup.current.code.len(), 6);
        assert!(
            setup
                .uri
                .starts_with("otpauth://totp/Microsoft:alice@contoso.com?secret=")
        );
    }

    #[test]
    fn reads_a_qr_code_from_an_image_file() {
        let dir = std::env::temp_dir().join(format!("zvault-otp-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("qr.png");
        qr_image(URI).save(&path).unwrap();
        let setup = scan_file(&path).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(setup.issuer, "Microsoft");
    }

    #[test]
    fn rejects_qr_codes_that_are_not_otp_setups() {
        assert!(matches!(
            decode_qr(&qr_image("https://example.com")),
            Err(ScanError::NotOtp)
        ));
        let blank = image::GrayImage::from_pixel(200, 200, image::Luma([255]));
        assert!(matches!(decode_qr(&blank), Err(ScanError::NoQrCode)));
    }

    #[test]
    fn parses_pasted_keys() {
        assert_eq!(
            otp_parse("jbsw y3dp ehpk 3pxp".into()).unwrap().uri,
            "otpauth://totp/?secret=JBSWY3DPEHPK3PXP"
        );
        assert!(otp_parse("nope!".into()).is_err());
    }

    #[test]
    fn codes_count_down() {
        let c = OtpCode::now(&Totp::parse(URI).unwrap());
        assert!((1..=30).contains(&c.remaining));
        assert_eq!(c.period, 30);
    }
}
