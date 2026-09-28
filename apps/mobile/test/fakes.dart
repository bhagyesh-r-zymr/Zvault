import 'dart:convert';

import 'package:zvault_mobile/src/app_state.dart';
import 'package:zvault_mobile/src/core.dart';
import 'package:zvault_mobile/src/storage.dart';

/// A Core that returns plaintext from a table instead of calling Rust.
class FakeCore extends Core {
  FakeCore({this.details = const {}, this.values = const {}});

  final Map<String, ItemDetail> details;
  final Map<String, String> values;
  bool locked = false;

  static const code = OneTimeCode(code: '492039', period: 30, remaining: 17);

  /// 2FA setups saved through [setItemTotp], by item id.
  final savedTotps = <String, String>{};

  /// What the last share was asked to include.
  bool? lastIncludeTotp;

  /// Plain ids in most tests; a JSON record where an item is saved.
  static String _id(String recordJson) =>
      recordJson.startsWith('{') ? (jsonDecode(recordJson) as Map)['id'] as String : recordJson;

  @override
  Future<ItemDetail> openItem(String vaultId, String recordJson) async {
    final d = details[recordJson] ?? details[_id(recordJson)]!;
    final saved = savedTotps[_id(recordJson)];
    if (saved == null) return d;
    return ItemDetail(
      title: d.title,
      username: d.username,
      password: d.password,
      urls: d.urls,
      notes: d.notes,
      hasTotp: saved.isNotEmpty,
      passkey: d.passkey,
    );
  }

  @override
  Future<OneTimeCode?> itemTotp(String vaultId, String recordJson) async =>
      (await openItem(vaultId, recordJson)).hasTotp ? code : null;

  @override
  Future<ItemSummary> itemSummary(String vaultId, String recordJson) async {
    final d = await openItem(vaultId, recordJson);
    return ItemSummary(
      title: d.title,
      username: d.username,
      url: null,
      hasTotp: d.hasTotp,
      hasPasskey: d.passkey != null,
    );
  }

  @override
  Future<TotpSetup> checkTotp(String input) async {
    if (!input.startsWith('otpauth://') && !RegExp(r'^[A-Z2-7 ]{16,}$').hasMatch(input)) {
      throw ArgumentError('not a setup key');
    }
    return const TotpSetup(issuer: 'Slack', account: 'meet.oza@zymr.com', current: code);
  }

  @override
  Future<OneTimeCode> sharedTotpCode(String uri) async => code;

  @override
  Future<String> setItemTotp(String vaultId, String recordJson, String totp) async {
    savedTotps[_id(recordJson)] = totp;
    return '{"v":1,"alg":"xchacha20poly1305","kid":"${_id(recordJson)}","nonce":"n2","ct":"sealed-with-totp"}';
  }

  /// Plaintext payloads of shares sent to this account, by share id.
  Map<String, String> incoming = {};

  @override
  Future<String> openShare({
    required String id,
    required String senderPublicKey,
    required String ephemeralPublicKey,
    required String blobJson,
  }) async => incoming[id]!;

  @override
  Future<String> openSecretValue(
    String projectId,
    String secretId,
    String environmentId,
    String blobJson,
  ) async => values[blobJson]!;

  @override
  Future<NewShareLink> createShareLink(
    String vaultId,
    String recordJson,
    String shareOrigin, {
    bool includeTotp = false,
  }) async {
    lastIncludeTotp = includeTotp;
    return NewShareLink(
      id: 'AAAAAAAAAAAAAAAAAAAAAA',
      verifier: 'verifier',
      blobJson: '{"v":1,"alg":"xchacha20poly1305","kid":"share-link","nonce":"n","ct":"c"}',
      url: '$shareOrigin/#AAAAAAAAAAAAAAAAAAAAAA.linkkey',
    );
  }

  /// Project secrets shared through [createSecretShareLink] or [sealSecretShareTo].
  final sharedSecrets = <SecretShare>[];

  @override
  Future<NewShareLink> createSecretShareLink(SecretShare secret, String shareOrigin) async {
    sharedSecrets.add(secret);
    return createShareLink('', '', shareOrigin);
  }

  @override
  Future<NewUserShare> sealSecretShareTo(SecretShare secret, String recipientPublicKey) async {
    sharedSecrets.add(secret);
    return sealShareTo('', '', recipientPublicKey);
  }

  @override
  Future<SharingIdentity> sharingIdentity() async =>
      const SharingIdentity(publicKey: 'my-key', fingerprint: 'mine');

  @override
  Future<String> sharingFingerprint(String publicKey) async => 'fp-$publicKey';

  @override
  Future<NewUserShare> sealShareTo(
    String vaultId,
    String recordJson,
    String recipientPublicKey, {
    bool includeTotp = false,
  }) async {
    lastIncludeTotp = includeTotp;
    return const NewUserShare(
      id: 'BBBBBBBBBBBBBBBBBBBBBB',
      senderPublicKey: 'my-key',
      ephemeralPublicKey: 'eph',
      blobJson: '{"v":1,"alg":"xchacha20poly1305","kid":"share-box","nonce":"n","ct":"c"}',
    );
  }

  int passkeyTests = 0;

  @override
  Future<void> testPasskey(String vaultId, String recordJson) async => passkeyTests++;

  @override
  void lock() => locked = true;

  @override
  void cancelPairing() {}
}

const email = 'meet.oza@zymr.com';

SavedAccount account({bool quickUnlock = true}) => SavedAccount(
  api: 'https://zvault.example',
  email: email,
  sessionToken: 'token',
  quickUnlock: quickUnlock,
);

VaultItem item(
  String id,
  String title,
  String username, {
  bool totp = false,
  bool passkey = false,
}) => VaultItem(
  vaultId: 'v1',
  vaultName: 'Personal',
  id: id,
  recordJson: id,
  summary: ItemSummary(
    title: title,
    username: username,
    url: null,
    hasTotp: totp,
    hasPasskey: passkey,
  ),
);

/// An unlocked app with two items and one project, without touching the network.
AppState unlockedState(FakeCore core) {
  final state = AppState(store: MemoryAccountStore(), core: core, deviceName: 'Test phone')
    ..account = account()
    ..phase = Phase.unlocked
    ..items = [
      item('i1', 'GitHub', 'meet-oza', totp: true),
      item('i2', 'Slack', 'meet.oza@zymr.com'),
    ];
  final p = Project('p1', {'name': 'Payments API', 'slug': 'payments-api', 'color': '#4C5BE8'});
  p.environments
    ..add(Environment('dev', {'name': 'Development', 'slug': 'dev', 'color': '#45D6A0'}, true))
    ..add(
      Environment('prod', {
        'name': 'Production',
        'slug': 'prod',
        'color': '#FF9A9A',
        'position': 1,
      }, false),
    );
  p.secrets.add(
    Secret('s1', {'name': 'Database URL', 'key': 'DATABASE_URL'}, {'dev': 'blob-db-dev'}),
  );
  state.projects = [p];
  return state;
}
