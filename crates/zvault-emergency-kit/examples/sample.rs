//! Writes a sample kit with a throwaway key: `cargo run -p zvault-emergency-kit --example sample -- out.pdf`

use zvault_crypto::SecretKey;
use zvault_emergency_kit::{Date, Kit};

fn main() {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "sample-kit.pdf".into());
    let key = SecretKey::generate().expect("system RNG");
    let pdf = Kit {
        email: "ada@example.com",
        sign_in_url: "https://my.zvault.app",
        secret_key: &key,
        created_on: Date::today(),
    }
    .render()
    .expect("valid sample details");
    std::fs::write(&path, &*pdf).expect("write sample kit");
    println!("wrote {path}");
}
