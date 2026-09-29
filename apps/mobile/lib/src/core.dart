import 'rust/api/pairing.dart' as pairing;
import 'rust/api/session.dart' as session;
import 'rust/api/sharing.dart' as sharing;
import 'rust/api/vault.dart' as vault;

export 'rust/api/pairing.dart' show PairedAccount, ScannedCode;
export 'rust/api/sharing.dart' show NewShareLink, NewUserShare, SecretShare, SharingIdentity;
export 'rust/api/vault.dart'
    show
        EnvironmentView,
        ItemDetail,
        ItemSummary,
        OneTimeCode,
        PasskeyDetail,
        SshKeyDetail,
        TotpSetup,
        VaultSummary;

/// The Rust core, behind an interface so screens can be tested without it.
/// Keys never cross into Dart except the keyset handed to the biometric store.
class Core {
  const Core();

  Future<pairing.ScannedCode> scan(String uri) => pairing.pairingScan(uri: uri);

  Future<pairing.PairedAccount> finishPairing(String ephemeralPublicKey, String nonce, String ct) =>
      pairing.pairingFinish(ephemeralPublicKey: ephemeralPublicKey, nonce: nonce, ct: ct);

  void cancelPairing() => pairing.pairingCancel();

  Future<void> unlock(String email, String keyset) => session.unlock(email: email, keyset: keyset);

  void lock() => session.lock();

  Future<vault.VaultSummary> openVault(String recordJson) =>
      vault.vaultOpen(recordJson: recordJson);

  Future<vault.ItemSummary> itemSummary(String vaultId, String recordJson) =>
      vault.itemSummary(vaultId: vaultId, recordJson: recordJson);

  Future<vault.ItemDetail> openItem(String vaultId, String recordJson) =>
      vault.itemOpen(vaultId: vaultId, recordJson: recordJson);

  Future<vault.OneTimeCode?> itemTotp(String vaultId, String recordJson) => vault.itemTotp(
    vaultId: vaultId,
    recordJson: recordJson,
    unixSecs: DateTime.now().millisecondsSinceEpoch ~/ 1000,
  );

  int get _now => DateTime.now().millisecondsSinceEpoch ~/ 1000;

  /// Checks a scanned or pasted 2FA setup before it is saved.
  Future<vault.TotpSetup> checkTotp(String input) => vault.totpCheck(input: input, unixSecs: _now);

  /// The current code for a setup someone shared.
  Future<vault.OneTimeCode> sharedTotpCode(String uri) => vault.totpCode(uri: uri, unixSecs: _now);

  /// Seals the item again with its 2FA setup added, replaced or (empty)
  /// removed. Returns the new `encryptedData` blob as JSON.
  Future<String> setItemTotp(String vaultId, String recordJson, String totp) =>
      vault.itemSetTotp(vaultId: vaultId, recordJson: recordJson, totp: totp);

  /// Signs a fresh WebAuthn challenge with the item's passkey and checks it
  /// with the public key. The private key stays in Rust.
  Future<void> testPasskey(String vaultId, String recordJson) =>
      vault.itemPasskeyTest(vaultId: vaultId, recordJson: recordJson);

  Future<String> openProject(String recordJson, String? memberWrapJson) =>
      vault.projectOpen(recordJson: recordJson, memberWrapJson: memberWrapJson);

  Future<vault.EnvironmentView> openEnvironment(
    String projectId,
    String entryJson,
    String? memberWrapJson,
  ) => vault.environmentOpen(
    projectId: projectId,
    entryJson: entryJson,
    memberWrapJson: memberWrapJson,
  );

  Future<String> openEntry(String projectId, String kind, String id, String blobJson) =>
      vault.entryOpen(projectId: projectId, kind: kind, id: id, blobJson: blobJson);

  Future<String> openSecretValue(
    String projectId,
    String secretId,
    String environmentId,
    String blobJson,
  ) => vault.secretValueOpen(
    projectId: projectId,
    secretId: secretId,
    environmentId: environmentId,
    blobJson: blobJson,
  );

  /// Encrypts an item under a fresh link key. The URL holds the key.
  Future<sharing.NewShareLink> createShareLink(
    String vaultId,
    String recordJson,
    String shareOrigin, {
    bool includeTotp = false,
  }) => sharing.shareLinkCreate(
    vaultId: vaultId,
    recordJson: recordJson,
    shareOrigin: shareOrigin,
    includeTotp: includeTotp,
  );

  /// Opens one project secret's value and encrypts it under a fresh link key.
  Future<sharing.NewShareLink> createSecretShareLink(
    sharing.SecretShare secret,
    String shareOrigin,
  ) => sharing.secretShareLinkCreate(secret: secret, shareOrigin: shareOrigin);

  Future<sharing.SharingIdentity> sharingIdentity() => sharing.sharingIdentity();

  Future<String> sharingFingerprint(String publicKey) =>
      sharing.sharingFingerprint(publicKey: publicKey);

  Future<sharing.NewUserShare> sealShareTo(
    String vaultId,
    String recordJson,
    String recipientPublicKey, {
    bool includeTotp = false,
  }) => sharing.shareSealTo(
    vaultId: vaultId,
    recordJson: recordJson,
    recipientPublicKey: recipientPublicKey,
    includeTotp: includeTotp,
  );

  /// Decrypts a share sent to this account; returns `SharedItemPayload` JSON.
  Future<String> openShare({
    required String id,
    required String senderPublicKey,
    required String ephemeralPublicKey,
    required String blobJson,
  }) => sharing.shareOpen(
    id: id,
    senderPublicKey: senderPublicKey,
    ephemeralPublicKey: ephemeralPublicKey,
    blobJson: blobJson,
  );

  Future<sharing.NewUserShare> sealSecretShareTo(
    sharing.SecretShare secret,
    String recipientPublicKey,
  ) => sharing.secretShareSealTo(secret: secret, recipientPublicKey: recipientPublicKey);
}
