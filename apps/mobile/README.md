# Zvault for phones

The Android app (iOS later), in Flutter. Sign in by scanning the QR code under **Settings › Devices › Add phone** on the Mac, then browse items and project secrets, and share an item by secure link (optionally limited to certain emails) or with another Zvault user. The item is encrypted on the phone; the link key stays in the URL fragment.

Crypto runs in Rust. `crates/zvault-mobile` wraps `zvault-crypto` and is called through [flutter_rust_bridge](https://cjycode.com/flutter_rust_bridge/). Keys never reach Dart, except the keyset handed to the Android Keystore behind a fingerprint.

## Run

```sh
cd apps/mobile
flutter pub get
flutter run            # a phone or emulator, Android 14 or later
flutter run -d linux   # a phone-sized desktop window, keys kept in memory only
flutter test
```

After changing `crates/zvault-mobile/src/api`, regenerate the bindings:

```sh
cargo install flutter_rust_bridge_codegen --version 2.13.0
flutter_rust_bridge_codegen generate
cargo fmt --all
```

CI builds the APK on every change here. Download it from the run's **zvault-android** artifact.
