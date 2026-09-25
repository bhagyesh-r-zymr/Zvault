import 'rust/api/pairing.dart' as pairing;
import 'rust/api/session.dart' as session;
import 'rust/api/vault.dart' as vault;

export 'rust/api/pairing.dart' show PairedAccount, ScannedCode;
export 'rust/api/vault.dart'
    show EnvironmentView, ItemDetail, ItemSummary, OneTimeCode, VaultSummary;

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
}
