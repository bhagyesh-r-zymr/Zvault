import 'dart:convert';

import 'package:http/http.dart' as http;

/// A failed call, with a message fit to show.
class ApiException implements Exception {
  ApiException(this.status, this.message);

  final int status;
  final String message;

  /// The session is gone (expired or signed out from another device).
  bool get signedOut => status == 401;

  @override
  String toString() => message;
}

/// What this phone says about itself (`DeviceInfo` in `@zvault/shared`).
class DeviceInfo {
  const DeviceInfo({required this.name, required this.platform, required this.appVersion});

  final String name;
  final String platform;
  final String appVersion;

  Map<String, String> toJson() => {'name': name, 'platform': platform, 'appVersion': appVersion};
}

/// The sealed account keys from the Mac (`PairingGrant`).
class PairingGrant {
  const PairingGrant(this.ephemeralPublicKey, this.nonce, this.ct);

  final String ephemeralPublicKey;
  final String nonce;
  final String ct;
}

sealed class PairingResult {}

class PairingWaiting extends PairingResult {}

class PairingDenied extends PairingResult {}

class PairingApproved extends PairingResult {
  PairingApproved(this.sessionToken, this.grant);

  final String sessionToken;
  final PairingGrant grant;
}

/// One page of changes: raw JSON records, passed to Rust to open.
class Page {
  Page(this.records, this.cursor, this.hasMore);

  final List<Map<String, dynamic>> records;
  final int cursor;
  final bool hasMore;
}

/// The Zvault API. Records come back as JSON maps; only Rust decrypts them.
class ZvaultApi {
  ZvaultApi(String baseUrl, {this.token, http.Client? client})
    : base = baseUrl.replaceAll(RegExp(r'/+$'), ''),
      _http = client ?? http.Client();

  final String base;
  String? token;
  final http.Client _http;

  static const _timeout = Duration(seconds: 20);

  Future<dynamic> _call(String method, String path, [Object? body]) async {
    final uri = Uri.parse('$base/v1$path');
    final headers = <String, String>{
      'Accept': 'application/json',
      if (body != null) 'Content-Type': 'application/json',
      if (token != null) 'Authorization': 'Bearer $token',
    };
    http.Response res;
    try {
      final req = http.Request(method, uri)..headers.addAll(headers);
      if (body != null) req.body = jsonEncode(body);
      res = await http.Response.fromStream(await _http.send(req).timeout(_timeout));
    } catch (_) {
      throw ApiException(0, "Can't reach the Zvault server. Check your connection.");
    }
    if (res.statusCode >= 400) {
      throw ApiException(res.statusCode, _message(res));
    }
    if (res.statusCode == 204 || res.body.isEmpty) return null;
    return jsonDecode(res.body);
  }

  static String _message(http.Response res) {
    try {
      final json = jsonDecode(res.body);
      if (json is Map && json['message'] is String) {
        final m = json['message'] as String;
        if (res.statusCode != 404 || m != 'Not Found') return m;
      }
    } catch (_) {}
    return switch (res.statusCode) {
      401 => 'Your session has ended. Sign in again from your Mac.',
      404 => 'This QR code has expired. Show a new one on your Mac.',
      409 => 'This QR code was already used. Show a new one on your Mac.',
      429 => 'Too many attempts. Wait a minute and try again.',
      _ => 'Something went wrong (${res.statusCode}). Try again.',
    };
  }

  // Pairing: the phone has no session yet.

  Future<void> claimPairing(
    String id, {
    required String claimToken,
    required String publicKey,
    required DeviceInfo device,
  }) async {
    await _call('POST', '/pairings/${Uri.encodeComponent(id)}/claim', {
      'claimToken': claimToken,
      'publicKey': publicKey,
      'device': device.toJson(),
    });
  }

  Future<PairingResult> pairingResult(String id, {required String claimToken}) async {
    final json = await _call('POST', '/pairings/${Uri.encodeComponent(id)}/result', {
      'claimToken': claimToken,
    });
    return switch (json['status']) {
      'approved' => PairingApproved(
        json['sessionToken'] as String,
        PairingGrant(
          json['grant']['ephemeralPublicKey'] as String,
          json['grant']['nonce'] as String,
          json['grant']['ct'] as String,
        ),
      ),
      'denied' => PairingDenied(),
      _ => PairingWaiting(),
    };
  }

  // Signed in.

  Future<void> logout() => _call('POST', '/auth/logout');

  Future<List<Map<String, dynamic>>> vaults() async {
    final json = await _call('GET', '/vaults');
    return (json['vaults'] as List).cast<Map<String, dynamic>>();
  }

  Future<Page> items(String vaultId, int since) async {
    final json = await _call('GET', '/vaults/${Uri.encodeComponent(vaultId)}/items?since=$since');
    return Page(
      (json['items'] as List).cast<Map<String, dynamic>>(),
      json['cursor'] as int,
      json['hasMore'] as bool,
    );
  }

  Future<List<Map<String, dynamic>>> projects() async {
    final json = await _call('GET', '/projects');
    return (json['projects'] as List).cast<Map<String, dynamic>>();
  }

  Future<Page> projectChanges(String projectId, int since) async {
    final json = await _call(
      'GET',
      '/projects/${Uri.encodeComponent(projectId)}/changes?since=$since',
    );
    return Page(
      (json['entries'] as List).cast<Map<String, dynamic>>(),
      json['cursor'] as int,
      json['hasMore'] as bool,
    );
  }

  /// This account's member wraps in a shared project (`MyProjectKeysResponse`).
  Future<Map<String, dynamic>> myProjectKeys(String projectId) async {
    return await _call('GET', '/access/projects/${Uri.encodeComponent(projectId)}/keys/me')
        as Map<String, dynamic>;
  }

  // Sharing. Bodies carry ciphertext, verifiers and public keys only; a link's
  // key stays in its URL on this phone.

  /// Registers a link (`CreateShareLinkRequest`). Returns the allowed emails
  /// that may not get the code while Zvault email is in test mode.
  Future<List<String>> createShareLink(Map<String, Object> body) async {
    final json = await _call('POST', '/shares/links', body);
    return ((json as Map)['unverifiedEmails'] as List? ?? const []).cast<String>();
  }

  /// Someone's published sharing key (`SharingKeyResponse`).
  Future<({String email, String publicKey})> sharingKey(String email) async {
    final json = await _call('GET', '/shares/keys?email=${Uri.encodeQueryComponent(email)}');
    return (email: json['email'] as String, publicKey: json['publicKey'] as String);
  }

  Future<void> publishSharingKey(String publicKey) =>
      _call('PUT', '/shares/keys/me', {'publicKey': publicKey});

  Future<void> shareWithUser(Map<String, Object> body) => _call('POST', '/shares/users', body);
}
