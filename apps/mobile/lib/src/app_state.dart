import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';

import 'api.dart';
import 'core.dart';
import 'storage.dart';

const appVersion = '0.1.0';
const memberKeyWrapKid = 'member-key-wrap';

enum Phase { loading, welcome, locked, unlocked }

class VaultItem {
  VaultItem({
    required this.vaultId,
    required this.vaultName,
    required this.id,
    required this.recordJson,
    required this.summary,
  });

  final String vaultId;
  final String vaultName;
  final String id;
  final String recordJson;
  final ItemSummary summary;
}

/// A link that was just made. [url] holds the link key: it is shown and
/// shared from this phone only.
class CreatedShareLink {
  const CreatedShareLink({
    required this.url,
    required this.maxViews,
    this.allowedEmails,
    this.unverifiedEmails = const [],
  });

  final String url;
  final int maxViews;

  /// Who may open it, or null for anyone with the link.
  final List<String>? allowedEmails;

  /// Allowed emails that may not get the code while Zvault email is in test mode.
  final List<String> unverifiedEmails;
}

enum PinCheck { newKey, match, changed }

/// Another Zvault user found by email, ready to share with.
class ShareRecipient {
  const ShareRecipient({
    required this.email,
    required this.publicKey,
    required this.fingerprint,
    required this.pin,
  });

  final String email;
  final String publicKey;

  /// Security code to compare with them out of band.
  final String fingerprint;
  final PinCheck pin;
}

/// Share limits from `SHARE_LIMITS` in `@zvault/shared`.
abstract final class ShareLimits {
  static const maxViews = 100;
  static const maxAllowedEmails = 20;
}

final _emailPattern = RegExp(r"^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$");

/// Splits what the person typed into normalized emails, or throws a message
/// fit to show. Same rules as the Mac's `parseEmails`.
List<String> parseShareEmails(String text) {
  final parts = text.split(RegExp(r'[\s,;]+')).where((p) => p.isNotEmpty);
  if (parts.isEmpty) throw const FormatException('Add at least one email.');
  final emails = <String>[];
  for (final part in parts) {
    final email = part.toLowerCase();
    if (email.length > 254 || !_emailPattern.hasMatch(email)) {
      throw FormatException('$part is not an email address.');
    }
    if (!emails.contains(email)) emails.add(email);
  }
  if (emails.length > ShareLimits.maxAllowedEmails) {
    throw const FormatException('A link can name at most ${ShareLimits.maxAllowedEmails} people.');
  }
  return emails;
}

class Environment {
  Environment(this.id, Map<String, dynamic> meta, this.unlocked)
    : name = meta['name'] as String? ?? 'Environment',
      slug = meta['slug'] as String? ?? '',
      kind = meta['kind'] as String? ?? 'custom',
      position = (meta['position'] as num?)?.toInt() ?? 0,
      color = meta['color'] as String? ?? envColors[meta['kind']] ?? envColors['custom'];

  /// Default dot colour per kind, as on the Mac (`ENV_COLORS`).
  static const envColors = {
    'development': '#45D6A0',
    'staging': '#F2B64C',
    'production': '#FF7A7A',
    'custom': '#D9A3F5',
  };

  final String id;
  final String name;
  final String slug;
  final String kind;
  final int position;
  final String? color;

  /// Whether this account can read values here.
  final bool unlocked;
}

class Folder {
  Folder(this.id, Map<String, dynamic> meta) : name = meta['name'] as String? ?? 'Folder';

  final String id;
  final String name;
}

class Secret {
  Secret(this.id, Map<String, dynamic> meta, this.values)
    : name = meta['name'] as String? ?? '',
      key = meta['key'] as String? ?? '',
      folderId = meta['folderId'] as String?,
      note = meta['note'] as String?;

  final String id;
  final String name;
  final String key;
  final String? folderId;
  final String? note;

  /// Sealed values by environment id, as JSON for Rust to open.
  final Map<String, String> values;
}

class Project {
  Project(this.id, Map<String, dynamic> meta)
    : name = meta['name'] as String? ?? 'Project',
      slug = meta['slug'] as String? ?? '',
      description = meta['description'] as String?,
      color = meta['color'] as String?;

  final String id;
  final String name;
  final String slug;
  final String? description;
  final String? color;
  final environments = <Environment>[];

  /// Tile colours, picked from the id like the Mac does when there's no colour.
  (String bg, String fg) get tile {
    if (color != null) return (color!, '#FFFFFF');
    var h = 0;
    for (final c in id.codeUnits) {
      h = (h * 31 + c) & 0xFFFFFFFF;
    }
    return _tiles[h % _tiles.length];
  }

  static const _tiles = [
    ('#4C5BE8', '#FFFFFF'),
    ('#1E3B33', '#7FE6BE'),
    ('#3A2A14', '#F2B64C'),
    ('#33203A', '#D9A3F5'),
  ];
  final folders = <String, Folder>{};
  final secrets = <Secret>[];
}

/// A scan in progress: the phone has claimed the QR code and waits for the Mac.
class PendingPairing {
  PendingPairing(this.api, this.scanned);

  final ZvaultApi api;
  final ScannedCode scanned;
}

/// App-wide state: who is signed in, whether the vault is unlocked, and the
/// decrypted names the screens list. Secret values are opened on demand.
class AppState extends ChangeNotifier {
  AppState({required this.store, this.core = const Core(), this.deviceName});

  final AccountStore store;
  final Core core;
  final String? deviceName;

  @visibleForTesting
  set api(ZvaultApi value) => _api = value;

  Phase phase = Phase.loading;
  SavedAccount? account;
  ZvaultApi? _api;

  /// Held between pairing and the fingerprint prompt only.
  String? _freshKeyset;

  List<VaultItem> items = [];
  List<Project> projects = [];
  bool syncing = false;
  String? syncError;
  DateTime? lastSynced;
  DateTime? _backgroundedAt;

  Future<void> start() async {
    account = await store.load();
    if (account == null) {
      phase = Phase.welcome;
    } else {
      _api = ZvaultApi(account!.api, token: account!.sessionToken);
      phase = Phase.locked;
    }
    notifyListeners();
  }

  DeviceInfo get device => DeviceInfo(
    name: deviceName ?? _defaultDeviceName(),
    platform: Platform.isIOS ? 'ios' : 'android',
    appVersion: appVersion,
  );

  static String _defaultDeviceName() {
    if (Platform.isIOS) return 'iPhone';
    if (Platform.isAndroid) return 'Android phone';
    return 'Phone';
  }

  // Pairing

  /// Reads the QR code and tells the server this phone wants in.
  Future<PendingPairing> beginPairing(String uri) async {
    final scanned = await core.scan(uri);
    final api = ZvaultApi(scanned.api);
    try {
      await api.claimPairing(
        scanned.pairingId,
        claimToken: scanned.claimToken,
        publicKey: scanned.publicKey,
        device: device,
      );
    } catch (_) {
      core.cancelPairing();
      rethrow;
    }
    return PendingPairing(api, scanned);
  }

  /// Checks once whether the Mac has decided. True when signed in.
  Future<bool> pollPairing(PendingPairing p) async {
    final result = await p.api.pairingResult(p.scanned.pairingId, claimToken: p.scanned.claimToken);
    switch (result) {
      case PairingWaiting():
        return false;
      case PairingDenied():
        core.cancelPairing();
        throw ApiException(403, 'Your Mac said no. Scan a new code to try again.');
      case PairingApproved(:final sessionToken, :final grant):
        final paired = await core.finishPairing(grant.ephemeralPublicKey, grant.nonce, grant.ct);
        account = SavedAccount(
          api: p.api.base,
          email: paired.email,
          sessionToken: sessionToken,
          quickUnlock: false,
        );
        _freshKeyset = paired.keyset;
        await store.save(account!);
        _api = ZvaultApi(account!.api, token: sessionToken);
        phase = Phase.unlocked;
        notifyListeners();
        unawaited(sync());
        return true;
    }
  }

  void cancelPairing() => core.cancelPairing();

  // Fingerprint unlock

  Future<QuickUnlockSupport> quickUnlockSupport() => store.quickUnlockSupport();

  /// Saves the keyset behind biometrics. Call right after pairing.
  Future<void> enableQuickUnlock() async {
    final keyset = _freshKeyset;
    if (keyset == null) return;
    await store.saveKeyset(keyset);
    _freshKeyset = null;
    account = account!.copyWith(quickUnlock: true);
    await store.save(account!);
    notifyListeners();
  }

  /// Keeps the keys for this session only; the next launch needs a new scan.
  void skipQuickUnlock() {
    _freshKeyset = null;
    notifyListeners();
  }

  bool get awaitingQuickUnlockChoice => _freshKeyset != null;

  Future<bool> unlockWithBiometrics() async {
    final a = account;
    if (a == null || !a.quickUnlock) return false;
    final keyset = await store.readKeyset();
    if (keyset == null) return false;
    await core.unlock(a.email, keyset);
    phase = Phase.unlocked;
    notifyListeners();
    unawaited(sync());
    return true;
  }

  void lock() {
    core.lock();
    items = [];
    projects = [];
    phase = account?.quickUnlock == true ? Phase.locked : Phase.welcome;
    if (phase == Phase.welcome) unawaited(_forget());
    notifyListeners();
  }

  Future<void> signOut() async {
    try {
      await _api?.logout();
    } catch (_) {
      // Signed out on the server already, or offline: still forget locally.
    }
    core.lock();
    await _forget();
    items = [];
    projects = [];
    phase = Phase.welcome;
    notifyListeners();
  }

  Future<void> _forget() async {
    await store.clear();
    account = null;
    _api = null;
    _freshKeyset = null;
  }

  Future<void> setAutoLock(int minutes) async {
    account = account!.copyWith(autoLockMinutes: minutes);
    await store.save(account!);
    notifyListeners();
  }

  // Auto-lock

  void appHidden() => _backgroundedAt ??= DateTime.now();

  void appShown() {
    final at = _backgroundedAt;
    _backgroundedAt = null;
    final minutes = account?.autoLockMinutes ?? 1;
    if (phase == Phase.unlocked &&
        at != null &&
        DateTime.now().difference(at) >= Duration(minutes: minutes)) {
      lock();
    }
  }

  // Sync

  Future<void> sync() async {
    final api = _api;
    if (api == null || syncing || phase != Phase.unlocked) return;
    syncing = true;
    syncError = null;
    notifyListeners();
    try {
      final loadedItems = await _loadItems(api);
      final loadedProjects = await _loadProjects(api);
      if (phase != Phase.unlocked) return;
      items = loadedItems;
      projects = loadedProjects;
      lastSynced = DateTime.now();
    } on ApiException catch (e) {
      if (e.signedOut) {
        await signOut();
        syncError = e.message;
      } else {
        syncError = e.message;
      }
    } catch (e) {
      syncError = 'Could not load your vault. Pull down to try again.';
    } finally {
      syncing = false;
      notifyListeners();
    }
  }

  Future<List<VaultItem>> _loadItems(ZvaultApi api) async {
    final out = <VaultItem>[];
    for (final record in await api.vaults()) {
      final VaultSummary vault;
      try {
        vault = await core.openVault(jsonEncode(record));
      } catch (_) {
        continue;
      }
      final byId = <String, Map<String, dynamic>>{};
      var since = 0;
      while (true) {
        final page = await api.items(vault.id, since);
        for (final item in page.records) {
          if (item['deleted'] == true) {
            byId.remove(item['id']);
          } else {
            byId[item['id'] as String] = item;
          }
        }
        since = page.cursor;
        if (!page.hasMore) break;
      }
      for (final item in byId.values) {
        final json = jsonEncode(item);
        try {
          out.add(
            VaultItem(
              vaultId: vault.id,
              vaultName: vault.name,
              id: item['id'] as String,
              recordJson: json,
              summary: await core.itemSummary(vault.id, json),
            ),
          );
        } catch (_) {
          // An item this device can't open is left out, as on the Mac.
        }
      }
    }
    out.sort((a, b) => a.summary.title.toLowerCase().compareTo(b.summary.title.toLowerCase()));
    return out;
  }

  Future<List<Project>> _loadProjects(ZvaultApi api) async {
    final out = <Project>[];
    for (final record in await api.projects()) {
      final id = record['id'] as String;
      Map<String, dynamic>? wraps;
      Project project;
      try {
        if (record['encryptedKey']?['kid'] == memberKeyWrapKid) {
          wraps = await api.myProjectKeys(id);
        }
        final projectWrap = wraps?['projectKey'];
        final meta = await core.openProject(
          jsonEncode(record),
          projectWrap == null ? null : jsonEncode(projectWrap),
        );
        project = Project(id, jsonDecode(meta) as Map<String, dynamic>);
      } catch (_) {
        continue;
      }

      final entries = <String, Map<String, dynamic>>{};
      var since = 0;
      while (true) {
        final page = await api.projectChanges(id, since);
        for (final e in page.records) {
          if (e['deleted'] == true) {
            entries.remove(e['id']);
          } else {
            entries[e['id'] as String] = e;
          }
        }
        since = page.cursor;
        if (!page.hasMore) break;
      }

      // Environments first: secrets need their keys.
      final ordered = entries.values.toList()
        ..sort((a, b) => _typeOrder(a['type']).compareTo(_typeOrder(b['type'])));
      for (final e in ordered) {
        final eid = e['id'] as String;
        try {
          switch (e['type']) {
            case 'environment':
              if (e['encryptedKey']?['kid'] == memberKeyWrapKid && wraps == null) {
                wraps = await api.myProjectKeys(id);
              }
              final envWrap = (wraps?['environments'] as List?)
                  ?.cast<Map<String, dynamic>>()
                  .where((w) => w['environmentId'] == eid)
                  .map((w) => w['wrap'])
                  .firstOrNull;
              final view = await core.openEnvironment(
                id,
                jsonEncode(e),
                envWrap == null ? null : jsonEncode(envWrap),
              );
              project.environments.add(
                Environment(eid, jsonDecode(view.metaJson) as Map<String, dynamic>, view.unlocked),
              );
            case 'folder':
              final meta = await core.openEntry(id, 'folder', eid, jsonEncode(e['encryptedMeta']));
              project.folders[eid] = Folder(eid, jsonDecode(meta) as Map<String, dynamic>);
            case 'secret':
              final meta = await core.openEntry(id, 'secret', eid, jsonEncode(e['encryptedMeta']));
              final values = <String, String>{
                for (final v in (e['values'] as List).cast<Map<String, dynamic>>())
                  v['environmentId'] as String: jsonEncode(v['encryptedValue']),
              };
              project.secrets.add(Secret(eid, jsonDecode(meta) as Map<String, dynamic>, values));
          }
        } catch (_) {
          // Unreadable entries are skipped, as on the Mac.
        }
      }
      project.environments.sort((a, b) => a.position.compareTo(b.position));
      project.secrets.sort((a, b) => a.key.compareTo(b.key));
      out.add(project);
    }
    out.sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
    return out;
  }

  static int _typeOrder(Object? type) => switch (type) {
    'environment' => 0,
    'folder' => 1,
    _ => 2,
  };

  // On-demand decryption

  Future<ItemDetail> openItem(VaultItem item) => core.openItem(item.vaultId, item.recordJson);

  Future<OneTimeCode?> itemCode(VaultItem item) => core.itemTotp(item.vaultId, item.recordJson);

  // Sharing, as on the Mac. Rust opens and encrypts the item; only
  // ciphertext reaches the server.

  /// The share page on the same server as the API, as the Mac builds it.
  String get shareOrigin => '${account!.api}/share';

  Future<CreatedShareLink> createShareLink(
    VaultItem item, {
    required int expiresInSeconds,
    required int maxViews,
    List<String>? allowedEmails,
  }) async {
    final link = await core.createShareLink(item.vaultId, item.recordJson, shareOrigin);
    final unverified = await _api!.createShareLink({
      'id': link.id,
      'verifier': link.verifier,
      'blob': jsonDecode(link.blobJson) as Map<String, dynamic>,
      'expiresInSeconds': expiresInSeconds,
      'maxViews': maxViews,
      'allowedEmails': ?allowedEmails,
    });
    return CreatedShareLink(
      url: link.url,
      maxViews: maxViews,
      allowedEmails: allowedEmails,
      unverifiedEmails: unverified,
    );
  }

  Future<ShareRecipient> findShareRecipient(String email) async {
    final key = await _api!.sharingKey(email.trim());
    final pinned = account?.sharingPins[key.email.toLowerCase()];
    return ShareRecipient(
      email: key.email,
      publicKey: key.publicKey,
      fingerprint: await core.sharingFingerprint(key.publicKey),
      pin: pinned == null
          ? PinCheck.newKey
          : pinned == key.publicKey
          ? PinCheck.match
          : PinCheck.changed,
    );
  }

  Future<void> shareWithUser(VaultItem item, ShareRecipient to) async {
    final api = _api!;
    await api.publishSharingKey((await core.sharingIdentity()).publicKey);
    final sealed = await core.sealShareTo(item.vaultId, item.recordJson, to.publicKey);
    await api.shareWithUser({
      'id': sealed.id,
      'recipientEmail': to.email,
      'recipientPublicKey': to.publicKey,
      'senderPublicKey': sealed.senderPublicKey,
      'ephemeralPublicKey': sealed.ephemeralPublicKey,
      'blob': jsonDecode(sealed.blobJson) as Map<String, dynamic>,
    });
    final a = account;
    if (a != null) {
      account = a.copyWith(sharingPins: {...a.sharingPins, to.email.toLowerCase(): to.publicKey});
      await store.save(account!);
    }
  }

  Future<String> openSecret(Project project, Secret secret, Environment env) {
    final blob = secret.values[env.id];
    if (blob == null) return Future.value('');
    return core.openSecretValue(project.id, secret.id, env.id, blob);
  }
}
