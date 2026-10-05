import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:zvault_mobile/src/api.dart';

import 'support.dart';

void main() {
  ZvaultApi api(Map<String, Handler> table, {List<String>? log}) => ZvaultApi(
    'https://zvault.example/',
    token: 'tok',
    client: routes(table, log: log),
  );

  test('sends the bearer token and JSON bodies', () async {
    late http.Request seen;
    final a = api({
      'POST /shares/users': (req) {
        seen = req;
        return http.Response('', 204);
      },
    });
    await a.shareWithUser({'id': 'x'});
    expect(seen.headers['Authorization'], 'Bearer tok');
    expect(seen.headers['Content-Type'], 'application/json');
    expect(jsonDecode(seen.body), {'id': 'x'});
    expect(a.base, 'https://zvault.example');
  });

  test('lists vaults, items and projects', () async {
    final log = <String>[];
    final a = api({
      'GET /vaults': (_) => json({
        'vaults': [
          {'id': 'v1'},
        ],
      }),
      'GET /vaults/v1/items': (_) => json({
        'items': [
          {'id': 'i1'},
        ],
        'cursor': 4,
        'hasMore': true,
      }),
      'GET /projects': (_) => json({
        'projects': [
          {'id': 'p1'},
        ],
      }),
      'GET /projects/p1/changes': (_) => json({'entries': [], 'cursor': 0, 'hasMore': false}),
      'GET /access/projects/p1/keys/me': (_) => json({'projectKey': null, 'environments': []}),
    }, log: log);

    expect((await a.vaults()).single['id'], 'v1');
    final page = await a.items('v1', 2);
    expect(page.records.single['id'], 'i1');
    expect(page.cursor, 4);
    expect(page.hasMore, isTrue);
    expect((await a.projects()).single['id'], 'p1');
    final changes = await a.projectChanges('p1', 0);
    expect(changes.records, isEmpty);
    expect(changes.hasMore, isFalse);
    expect((await a.myProjectKeys('p1'))['environments'], isEmpty);
    expect(log, contains('GET /v1/vaults/v1/items?since=2'));
  });

  test('saves an item and returns the stored record', () async {
    final a = api({
      'PUT /vaults/v1/items/i1': (req) => json({'id': 'i1', 'revision': 3}),
    });
    final saved = await a.putItem('v1', 'i1', {'baseRevision': 2});
    expect(saved['revision'], 3);
  });

  group('sharing', () {
    test('registers a link and reports unverified emails', () async {
      final a = api({
        'POST /shares/links': (_) => json({
          'unverifiedEmails': ['a@b.co'],
        }),
      });
      expect(await a.createShareLink({'id': 'x'}), ['a@b.co']);
    });

    test('a link with no unverified emails gives an empty list', () async {
      final a = api({'POST /shares/links': (_) => json({})});
      expect(await a.createShareLink({'id': 'x'}), isEmpty);
    });

    test('finds and publishes sharing keys', () async {
      final log = <String>[];
      final a = api({
        'GET /shares/keys': (_) => json({'email': 'a@b.co', 'publicKey': 'pk'}),
        'PUT /shares/keys/me': (_) => http.Response('', 204),
      }, log: log);
      final key = await a.sharingKey('a+b@b.co');
      expect(key.email, 'a@b.co');
      expect(key.publicKey, 'pk');
      await a.publishSharingKey('mine');
      expect(log.first, contains('email=a%2Bb%40b.co'));
    });

    test('lists and removes shares sent here', () async {
      final log = <String>[];
      final a = api({
        'GET /shares/users': (_) => json({
          'incoming': [
            {'id': 's1'},
          ],
        }),
        'DELETE /shares/users/s1': (_) => http.Response('', 204),
      }, log: log);
      expect((await a.incomingShares()).single['id'], 's1');
      await a.removeUserShare('s1');
      expect(log.last, 'DELETE /v1/shares/users/s1');
    });
  });

  group('pairing', () {
    test('claims a code and reads waiting and denied results', () async {
      var status = 'waiting';
      final a = api({
        'POST /pairings/p%201/claim': (_) => http.Response('', 204),
        'POST /pairings/p%201/result': (_) => json({'status': status}),
      });
      await a.claimPairing(
        'p 1',
        claimToken: 'c',
        publicKey: 'k',
        device: const DeviceInfo(name: 'n', platform: 'android', appVersion: '1'),
      );
      expect(await a.pairingResult('p 1', claimToken: 'c'), isA<PairingWaiting>());
      status = 'denied';
      expect(await a.pairingResult('p 1', claimToken: 'c'), isA<PairingDenied>());
    });

    test('device info is what the server expects', () {
      expect(const DeviceInfo(name: 'n', platform: 'android', appVersion: '1').toJson(), {
        'name': 'n',
        'platform': 'android',
        'appVersion': '1',
      });
    });
  });

  group('errors', () {
    Future<ApiException> fail(http.Response Function() res) async {
      final a = ZvaultApi('https://zvault.example', client: MockClient((_) async => res()));
      try {
        await a.logout();
      } on ApiException catch (e) {
        return e;
      }
      throw StateError('did not throw');
    }

    test('uses the server message when there is one', () async {
      final e = await fail(() => http.Response('{"message":"Link expired"}', 410));
      expect(e.message, 'Link expired');
      expect(e.status, 410);
      expect(e.toString(), 'Link expired');
      expect(e.signedOut, isFalse);
    });

    test('explains common statuses when the body says nothing useful', () async {
      expect((await fail(() => http.Response('', 401))).message, contains('session has ended'));
      expect((await fail(() => http.Response('', 401))).signedOut, isTrue);
      expect((await fail(() => http.Response('x', 404))).message, contains('expired'));
      expect((await fail(() => http.Response('{}', 409))).message, contains('already used'));
      expect((await fail(() => http.Response('', 429))).message, contains('Too many'));
      expect((await fail(() => http.Response('', 503))).message, contains('(503)'));
    });

    test('a connection problem says so', () async {
      final a = ZvaultApi('https://zvault.example', client: MockClient((_) => throw Exception()));
      expect(() => a.logout(), throwsA(isA<ApiException>().having((e) => e.status, 'status', 0)));
    });
  });
}
