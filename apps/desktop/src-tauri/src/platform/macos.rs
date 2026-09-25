//! macOS bindings: system sleep / screen-lock notifications and the
//! biometric-protected Keychain item used for Touch ID unlock.
//!
//! This is the only module in the crate allowed to use `unsafe`. Every block
//! states why the call is sound.
#![allow(unsafe_code)]

pub mod events {
    use std::ptr::NonNull;
    use std::sync::Arc;

    use block2::RcBlock;
    use objc2_app_kit::{
        NSWorkspace, NSWorkspaceScreensDidSleepNotification,
        NSWorkspaceSessionDidResignActiveNotification, NSWorkspaceWillSleepNotification,
    };
    use objc2_foundation::{
        NSDistributedNotificationCenter, NSNotification, NSNotificationCenter, NSNotificationName,
        NSString,
    };

    use crate::session::LockReason;

    pub fn watch(on_event: impl Fn(LockReason) + Send + Sync + 'static) {
        let on_event: Arc<dyn Fn(LockReason) + Send + Sync> = Arc::new(on_event);
        let workspace = NSWorkspace::sharedWorkspace().notificationCenter();

        // SAFETY: these are immutable `NSString` constants exported by AppKit,
        // valid for the life of the process.
        let (will_sleep, screens_slept, session_resigned) = unsafe {
            (
                NSWorkspaceWillSleepNotification,
                NSWorkspaceScreensDidSleepNotification,
                NSWorkspaceSessionDidResignActiveNotification,
            )
        };
        observe(&workspace, will_sleep, LockReason::Sleep, &on_event);
        observe(
            &workspace,
            screens_slept,
            LockReason::ScreenLocked,
            &on_event,
        );
        observe(
            &workspace,
            session_resigned,
            LockReason::ScreenLocked,
            &on_event,
        );

        let distributed = NSDistributedNotificationCenter::defaultCenter();
        observe(
            &distributed,
            &NSString::from_str("com.apple.screenIsLocked"),
            LockReason::ScreenLocked,
            &on_event,
        );
    }

    fn observe(
        center: &NSNotificationCenter,
        name: &NSNotificationName,
        reason: LockReason,
        on_event: &Arc<dyn Fn(LockReason) + Send + Sync>,
    ) {
        let on_event = Arc::clone(on_event);
        let block = RcBlock::new(move |_: NonNull<NSNotification>| on_event(reason));
        // SAFETY: `object` is nil, so no type requirement applies. With a nil
        // queue the block runs on the posting thread; it only calls a
        // `Send + Sync` closure, so any thread is fine.
        let token = unsafe {
            center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block)
        };
        // Observers are removed when their token is released. These are meant
        // to live as long as the app, so the token is intentionally leaked.
        std::mem::forget(token);
    }
}

pub mod keychain {
    use objc2_local_authentication::{LAContext, LAPolicy};
    use security_framework::access_control::{ProtectionMode, SecAccessControl};
    use security_framework::passwords::{
        delete_generic_password_options, generic_password, set_generic_password_options,
    };
    use security_framework::passwords_options::{AccessControlOptions, PasswordOptions};
    use zeroize::Zeroizing;

    use std::time::SystemTime;

    use zvault_crypto::SymmetricKey;

    use crate::biometric::{BiometricError, Record, encode_record};

    const SERVICE: &str = "com.zvault.desktop.touch-id-unlock";

    const ERR_SEC_USER_CANCELED: i32 = -128;
    const ERR_SEC_AUTH_FAILED: i32 = -25293;
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
    const ERR_SEC_MISSING_ENTITLEMENT: i32 = -34018;

    fn options(account_id: &str) -> PasswordOptions {
        let mut o = PasswordOptions::new_generic_password(SERVICE, account_id);
        // Biometric access control only works in the data-protection keychain,
        // which also keeps the item out of the legacy login keychain file.
        o.use_protected_keychain();
        o.set_access_synchronized(Some(false));
        o
    }

    fn map_err(e: security_framework::base::Error) -> BiometricError {
        match e.code() {
            ERR_SEC_ITEM_NOT_FOUND => BiometricError::NotEnrolled,
            ERR_SEC_USER_CANCELED | ERR_SEC_AUTH_FAILED => BiometricError::Cancelled,
            ERR_SEC_MISSING_ENTITLEMENT => BiometricError::MissingEntitlement,
            code => BiometricError::Keychain { code },
        }
    }

    /// Whether Touch ID is present, enrolled and not locked out.
    pub fn available() -> bool {
        // SAFETY: `LAContext` has no initialisation requirements, and the
        // preflight check does not prompt or touch shared state.
        unsafe {
            LAContext::new()
                .canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthenticationWithBiometrics)
                .is_ok()
        }
    }

    pub fn store(
        account_id: &str,
        key: &SymmetricKey,
        password_verified_at: SystemTime,
    ) -> Result<(), BiometricError> {
        if !available() {
            return Err(BiometricError::Unavailable);
        }
        // Replace rather than update, so the access control is always ours.
        delete(account_id)?;

        let access = SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleWhenPasscodeSetThisDeviceOnly),
            AccessControlOptions::BIOMETRY_CURRENT_SET.bits(),
        )
        .map_err(map_err)?;
        let mut o = options(account_id);
        o.set_access_control(access);
        o.set_label("Zvault Touch ID unlock");
        set_generic_password_options(encode_record(key, password_verified_at).as_ref(), o)
            .map_err(map_err)
    }

    /// Reads the record. macOS shows the Touch ID prompt; this blocks until
    /// the user responds, so call it off the main thread.
    pub fn load(account_id: &str) -> Result<Record, BiometricError> {
        let bytes = Zeroizing::new(generic_password(options(account_id)).map_err(map_err)?);
        Record::decode(&bytes).ok_or(BiometricError::NotEnrolled)
    }

    pub fn delete(account_id: &str) -> Result<(), BiometricError> {
        match delete_generic_password_options(options(account_id)) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(e) => Err(map_err(e)),
        }
    }
}

/// The Secret Key saved after the first sign-in on this Mac, so the person
/// doesn't retype it. It lives in the login keychain, which works in unsigned
/// builds (the data-protection keychain needs an entitlement).
pub mod secret_key {
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };
    use zeroize::Zeroizing;

    const SERVICE: &str = "com.zvault.desktop.secret-key";
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

    pub fn save(account_id: &str, key: &str) -> Result<(), String> {
        set_generic_password(SERVICE, account_id, key.as_bytes()).map_err(|e| e.to_string())
    }

    /// `None` if nothing is saved or the person denied the keychain prompt
    /// (unsigned builds see one after each update).
    pub fn load(account_id: &str) -> Option<Zeroizing<String>> {
        let bytes = Zeroizing::new(get_generic_password(SERVICE, account_id).ok()?);
        core::str::from_utf8(&bytes)
            .ok()
            .map(|s| Zeroizing::new(s.to_owned()))
    }

    pub fn delete(account_id: &str) -> Result<(), String> {
        match delete_generic_password(SERVICE, account_id) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// The vault key kept for "Stay unlocked", so Zvault opens unlocked after a
/// quit or restart. Like the Secret Key it lives in the login keychain, which
/// works in unsigned builds; it never syncs to iCloud.
pub mod saved_session {
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };
    use zeroize::Zeroizing;

    const SERVICE: &str = "com.zvault.desktop.stay-unlocked";
    /// One saved session per Mac.
    const ACCOUNT: &str = "session";
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

    pub fn save(record: &[u8]) -> Result<(), String> {
        set_generic_password(SERVICE, ACCOUNT, record).map_err(|e| e.to_string())
    }

    /// `None` if nothing is saved or the person denied the keychain prompt.
    pub fn load() -> Option<Zeroizing<Vec<u8>>> {
        get_generic_password(SERVICE, ACCOUNT)
            .ok()
            .map(Zeroizing::new)
    }

    pub fn delete() -> Result<(), String> {
        match delete_generic_password(SERVICE, ACCOUNT) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}
