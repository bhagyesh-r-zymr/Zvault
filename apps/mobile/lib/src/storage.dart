import 'dart:convert';
import 'dart:io';

import 'package:biometric_storage/biometric_storage.dart';

/// What the phone remembers between launches. None of it opens the vault on
/// its own: the keyset is stored separately, behind biometrics.
class SavedAccount {
  const SavedAccount({
    required this.api,
    required this.email,
    required this.sessionToken,
    required this.quickUnlock,
    this.autoLockMinutes = 1,
  });

  final String api;
  final String email;
  final String sessionToken;

  /// Whether the keyset is saved for fingerprint unlock.
  final bool quickUnlock;
  final int autoLockMinutes;

  SavedAccount copyWith({bool? quickUnlock, int? autoLockMinutes}) => SavedAccount(
    api: api,
    email: email,
    sessionToken: sessionToken,
    quickUnlock: quickUnlock ?? this.quickUnlock,
    autoLockMinutes: autoLockMinutes ?? this.autoLockMinutes,
  );

  Map<String, Object> toJson() => {
    'v': 1,
    'api': api,
    'email': email,
    'sessionToken': sessionToken,
    'quickUnlock': quickUnlock,
    'autoLockMinutes': autoLockMinutes,
  };

  static SavedAccount? fromJson(String? text) {
    if (text == null || text.isEmpty) return null;
    try {
      final j = jsonDecode(text) as Map<String, dynamic>;
      return SavedAccount(
        api: j['api'] as String,
        email: j['email'] as String,
        sessionToken: j['sessionToken'] as String,
        quickUnlock: j['quickUnlock'] as bool? ?? false,
        autoLockMinutes: j['autoLockMinutes'] as int? ?? 1,
      );
    } catch (_) {
      return null;
    }
  }
}

enum QuickUnlockSupport { available, notEnrolled, unsupported }

/// Keeps the account and, behind biometrics, the keyset.
abstract class AccountStore {
  Future<SavedAccount?> load();
  Future<void> save(SavedAccount account);
  Future<QuickUnlockSupport> quickUnlockSupport();

  /// Saves the keyset so that reading it back needs a fingerprint or face.
  Future<void> saveKeyset(String keyset);

  /// Asks for a fingerprint or face. Null if the person cancelled.
  Future<String?> readKeyset();

  /// Forgets everything, as on sign-out.
  Future<void> clear();
}

AccountStore defaultAccountStore() =>
    Platform.isAndroid || Platform.isIOS ? BiometricAccountStore() : MemoryAccountStore();

/// Android Keystore and iOS Keychain. The keyset's key requires a biometric
/// check for every read, so it can't be read while the phone is locked or by
/// another app.
class BiometricAccountStore implements AccountStore {
  static const _profileName = 'zvault_account';
  static const _keysetName = 'zvault_keyset';
  static const _prompt = PromptInfo(
    androidPromptInfo: AndroidPromptInfo(
      title: 'Unlock Zvault',
      subtitle: 'Use your fingerprint or face',
      negativeButton: 'Cancel',
      confirmationRequired: false,
    ),
    iosPromptInfo: IosPromptInfo(
      accessTitle: 'Unlock Zvault',
      saveTitle: 'Turn on Face ID for Zvault',
    ),
  );

  final _bio = BiometricStorage();

  Future<BiometricStorageFile> _profile() =>
      _bio.getStorage(_profileName, options: StorageFileInitOptions(authenticationRequired: false));

  Future<BiometricStorageFile> _keyset() => _bio.getStorage(
    _keysetName,
    options: StorageFileInitOptions(
      authenticationRequired: true,
      authenticationValidityDurationSeconds: -1,
      androidBiometricOnly: true,
      darwinBiometricOnly: true,
    ),
    promptInfo: _prompt,
  );

  @override
  Future<SavedAccount?> load() async => SavedAccount.fromJson(await (await _profile()).read());

  @override
  Future<void> save(SavedAccount account) async =>
      (await _profile()).write(jsonEncode(account.toJson()));

  @override
  Future<QuickUnlockSupport> quickUnlockSupport() async {
    final r = await _bio.canAuthenticate();
    return switch (r) {
      CanAuthenticateResponse.success => QuickUnlockSupport.available,
      CanAuthenticateResponse.errorNoBiometricEnrolled => QuickUnlockSupport.notEnrolled,
      _ => QuickUnlockSupport.unsupported,
    };
  }

  @override
  Future<void> saveKeyset(String keyset) async => (await _keyset()).write(keyset);

  @override
  Future<String?> readKeyset() async {
    try {
      return await (await _keyset()).read();
    } on AuthException catch (e) {
      if (e.code == AuthExceptionCode.userCanceled || e.code == AuthExceptionCode.canceled) {
        return null;
      }
      rethrow;
    }
  }

  @override
  Future<void> clear() async {
    await (await _profile()).delete();
    await (await _keyset()).delete();
  }
}

/// For running the app on a Linux desktop during development. Nothing is
/// written to disk, so closing the app signs out.
class MemoryAccountStore implements AccountStore {
  SavedAccount? _account;
  String? _keyset;

  @override
  Future<SavedAccount?> load() async => _account;

  @override
  Future<void> save(SavedAccount account) async => _account = account;

  @override
  Future<QuickUnlockSupport> quickUnlockSupport() async => QuickUnlockSupport.available;

  @override
  Future<void> saveKeyset(String keyset) async => _keyset = keyset;

  @override
  Future<String?> readKeyset() async => _keyset;

  @override
  Future<void> clear() async {
    _account = null;
    _keyset = null;
  }
}
