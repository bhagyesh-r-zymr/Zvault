# Zvault

A 1Password-style password manager. End-to-end encrypted. Zero-knowledge.

## Goal
Build a native **macOS app** with a backend on **AWS** that lets people store and share passwords safely.

## Must-have features
- **Sign up** with email + master password.
- **Emergency Kit** — a downloadable PDF with the account Secret Key, shown right after sign-up (like 1Password).
- **2FA (TOTP)** — set up by scanning a QR code in any authenticator app.
- **Vaults & items** — save, edit, search passwords and notes.
- **Sharing** — share an item by secure link (expiry + view limit) or by email to another user.

## Non-negotiables (security)
- **End-to-end encrypted.** Encrypt/decrypt only on the device. Server never sees plaintext, master password, or Secret Key.
- **Key derivation:** master password + Secret Key → strong KDF (Argon2id) → account key. Auth via SRP or similar (no password sent to server).
- **Share links:** decryption key lives in the URL fragment (`#...`), never sent to server.
- **AWS baseline:** KMS, least-privilege IAM, TLS 1.2+ everywhere, encryption at rest, WAF, CloudTrail, secrets in Secrets Manager.
- **macOS:** store local keys in Keychain; support Touch ID unlock.
- No secrets in this repo. Ever.
