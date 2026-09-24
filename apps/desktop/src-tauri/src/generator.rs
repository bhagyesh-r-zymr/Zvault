//! Password generation and strength commands. Generation happens in Rust so
//! every random choice comes from the OS CSPRNG rather than the webview.

use zeroize::Zeroize;
use zvault_passwords::{Generated, PassphraseOptions, PasswordOptions, Strength};

#[tauri::command]
pub fn generate_password(options: PasswordOptions) -> Result<Generated, String> {
    zvault_passwords::generate_password(&options).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn generate_passphrase(options: PassphraseOptions) -> Result<Generated, String> {
    zvault_passwords::generate_passphrase(&options).map_err(|e| e.to_string())
}

/// Async so zxcvbn runs off the main thread and never stalls the window.
#[tauri::command]
pub async fn check_password_strength(
    mut password: String,
    mut user_inputs: Vec<String>,
) -> Strength {
    let inputs: Vec<&str> = user_inputs.iter().map(String::as_str).collect();
    let strength = zvault_passwords::estimate_strength(&password, &inputs);
    password.zeroize();
    user_inputs.zeroize();
    strength
}
