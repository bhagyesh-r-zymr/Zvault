import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:zvault_mobile/src/core.dart';

import 'fakes.dart';

typedef Handler = http.Response Function(http.Request req);

/// Answers requests by "METHOD /path" (query string ignored); anything else is a 500.
MockClient routes(Map<String, Handler> table, {List<String>? log}) => MockClient((req) async {
  final key = '${req.method} ${req.url.path.replaceFirst('/v1', '')}';
  log?.add('${req.method} ${req.url.path}${req.url.hasQuery ? '?${req.url.query}' : ''}');
  final h = table[key];
  if (h == null) return http.Response('{"message":"no route $key"}', 500);
  return h(req);
});

http.Response json(Object body, [int status = 200]) => http.Response(jsonEncode(body), status);

/// A Core that opens records by reading their JSON, so sync can run without Rust.
class SyncCore extends FakeCore {
  SyncCore() : super(details: {}, values: {});

  final calls = <String>[];
  bool scanFails = false;
  bool unlockFails = false;

  @override
  Future<ScannedCode> scan(String uri) async {
    if (scanFails) throw Exception('bad code');
    return const ScannedCode(
      api: 'https://zvault.example',
      pairingId: 'pair1',
      claimToken: 'claim',
      publicKey: 'phone-key',
      code: '123456',
    );
  }

  int cancelled = 0;

  @override
  void cancelPairing() => cancelled++;

  @override
  Future<PairedAccount> finishPairing(String ephemeralPublicKey, String nonce, String ct) async =>
      const PairedAccount(email: email, keyset: 'keyset-json');

  String? unlockedWith;

  @override
  Future<void> unlock(String email, String keyset) async {
    if (unlockFails) throw Exception('nope');
    unlockedWith = keyset;
  }

  @override
  Future<VaultSummary> openVault(String recordJson) async {
    final r = jsonDecode(recordJson) as Map;
    if (r['broken'] == true) throw Exception('cannot open');
    return VaultSummary(id: r['id'] as String, name: r['name'] as String);
  }

  @override
  Future<ItemSummary> itemSummary(String vaultId, String recordJson) async {
    final r = jsonDecode(recordJson) as Map;
    if (r['broken'] == true) throw Exception('cannot open');
    return ItemSummary(
      title: r['title'] as String,
      username: '',
      url: null,
      hasTotp: false,
      hasPasskey: false,
      hasSshKey: false,
    );
  }

  @override
  Future<String> openProject(String recordJson, String? memberWrapJson) async {
    calls.add('project wrap=$memberWrapJson');
    final r = jsonDecode(recordJson) as Map;
    if (r['broken'] == true) throw Exception('cannot open');
    return jsonEncode({'name': r['name']});
  }

  @override
  Future<EnvironmentView> openEnvironment(
    String projectId,
    String entryJson,
    String? memberWrapJson,
  ) async {
    calls.add('env wrap=$memberWrapJson');
    final e = jsonDecode(entryJson) as Map;
    if (e['broken'] == true) throw Exception('cannot open');
    return EnvironmentView(
      metaJson: jsonEncode({'name': e['name'], 'position': e['position'], 'kind': e['kind']}),
      unlocked: memberWrapJson != null || e['open'] == true,
    );
  }

  @override
  Future<String> openEntry(String projectId, String kind, String id, String blobJson) async =>
      blobJson;
}
