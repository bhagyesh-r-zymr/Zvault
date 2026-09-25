import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'dart:convert';

import 'package:zvault_mobile/main.dart';
import 'package:zvault_mobile/src/api.dart';
import 'package:zvault_mobile/src/app_state.dart';
import 'package:zvault_mobile/src/core.dart';
import 'package:zvault_mobile/src/storage.dart';

import 'fakes.dart';

void main() {
  testWidgets('a new phone is asked to scan the QR code on the Mac', (tester) async {
    final state = AppState(store: MemoryAccountStore(), core: FakeCore());
    await state.start();
    await tester.pumpWidget(ZvaultApp(state: state));
    await tester.pumpAndSettle();

    expect(find.text('Sign in with QR code'), findsOneWidget);
    expect(find.text('Add phone'), findsOneWidget);
  });

  testWidgets('items are listed and searchable', (tester) async {
    await tester.pumpWidget(ZvaultApp(state: unlockedState(FakeCore())));
    await tester.pumpAndSettle();

    expect(find.text('GitHub'), findsOneWidget);
    expect(find.text('Slack'), findsOneWidget);

    await tester.enterText(find.byKey(const Key('items-search')), 'git');
    await tester.pump();
    expect(find.text('GitHub'), findsOneWidget);
    expect(find.text('Slack'), findsNothing);
  });

  testWidgets('an item hides its password until asked and shows its code', (tester) async {
    final core = FakeCore(
      details: {
        'i1': const ItemDetail(
          title: 'GitHub',
          username: 'meet-oza',
          password: 'tr0ub4dor&3',
          urls: ['https://github.com'],
          notes: '',
          hasTotp: true,
        ),
      },
    );
    await tester.pumpWidget(ZvaultApp(state: unlockedState(core)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('GitHub'));
    await tester.pumpAndSettle();

    expect(find.text('meet-oza'), findsOneWidget);
    expect(find.textContaining('tr0ub4dor'), findsNothing);
    expect(find.text('492 039'), findsOneWidget);

    await tester.tap(find.byKey(const Key('reveal-password')));
    await tester.pump();
    expect(find.textContaining('tr0ub4dor', findRichText: true), findsOneWidget);

    // Leave the detail screen so its countdown timer stops.
    await tester.pageBack();
    await tester.pumpAndSettle();
  });

  testWidgets('a project opens values only where this account has access', (tester) async {
    final core = FakeCore(values: {'blob-db-dev': 'postgres://dev'});
    await tester.pumpWidget(ZvaultApp(state: unlockedState(core)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('tab-projects')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Payments API'));
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('Show'));
    await tester.pumpAndSettle();
    expect(find.text('postgres://dev', findRichText: true), findsOneWidget);

    await tester.tap(find.byKey(const Key('env-prod')));
    await tester.pumpAndSettle();
    expect(find.textContaining("You don't have access to Production"), findsOneWidget);
    expect(find.text('postgres://dev', findRichText: true), findsNothing);
  });

  testWidgets('locking forgets what was decrypted', (tester) async {
    final core = FakeCore();
    final state = unlockedState(core);
    await tester.pumpWidget(ZvaultApp(state: state));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('tab-settings')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Lock now'));
    await tester.pump();

    expect(core.locked, isTrue);
    expect(state.items, isEmpty);
    expect(state.phase, Phase.locked);
  });

  group('sharing', () {
    const github = ItemDetail(
      title: 'GitHub',
      username: 'meet-oza',
      password: 'tr0ub4dor&3',
      urls: ['https://github.com'],
      notes: '',
      hasTotp: false,
    );

    Future<AppState> openShare(WidgetTester tester, List<http.Request> requests) async {
      // A tall phone, so the whole share form fits without scrolling.
      tester.view
        ..devicePixelRatio = 1
        ..physicalSize = const Size(412, 1400);
      addTearDown(tester.view.reset);
      final state = unlockedState(FakeCore(details: {'i2': github}))
        ..api = ZvaultApi(
          'https://zvault.example',
          token: 'token',
          client: MockClient((req) async {
            requests.add(req);
            return switch (req.url.path) {
              '/v1/shares/links' => http.Response('{"unverifiedEmails":["vivek@zymr.com"]}', 201),
              '/v1/shares/keys' => http.Response(
                '{"userId":"u2","email":"jayesh@zymr.com","publicKey":"their-key"}',
                200,
              ),
              _ => http.Response('{}', 200),
            };
          }),
        );
      await tester.pumpWidget(ZvaultApp(state: state));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Slack'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('share-item')));
      await tester.pumpAndSettle();
      return state;
    }

    testWidgets('makes an email-restricted link and keeps its key off the server', (tester) async {
      final requests = <http.Request>[];
      await openShare(tester, requests);

      await tester.tap(find.byKey(const Key('share-only-emails')));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('share-emails')), 'Vivek@zymr.com, nope');
      await tester.tap(find.byKey(const Key('share-create-link')));
      await tester.pumpAndSettle();
      expect(find.text('nope is not an email address.'), findsOneWidget);
      expect(requests, isEmpty);

      await tester.enterText(find.byKey(const Key('share-emails')), 'Vivek@zymr.com');
      await tester.tap(find.byKey(const Key('share-create-link')));
      await tester.pumpAndSettle();

      expect(requests, hasLength(1));
      final body = jsonDecode(requests.single.body) as Map<String, dynamic>;
      expect(body['allowedEmails'], ['vivek@zymr.com']);
      expect(body['maxViews'], 1);
      expect(body['expiresInSeconds'], 7 * 24 * 60 * 60);
      expect(requests.single.body, isNot(contains('linkkey')));

      expect(
        find.text('https://zvault.example/share/#AAAAAAAAAAAAAAAAAAAAAA.linkkey'),
        findsOneWidget,
      );
      expect(find.text('Share link'), findsOneWidget);
      expect(find.text('Email the link'), findsOneWidget);
      expect(find.textContaining('test mode'), findsOneWidget);
    });

    testWidgets('shares with a Zvault user and pins their key', (tester) async {
      final requests = <http.Request>[];
      final state = await openShare(tester, requests);

      await tester.tap(find.text('Zvault user'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('share-person-email')), 'jayesh@zymr.com');
      await tester.pump();
      await tester.tap(find.text('Find'));
      await tester.pumpAndSettle();
      expect(find.text('fp-their-key'), findsOneWidget);

      await tester.tap(find.text('Share with jayesh@zymr.com'));
      await tester.pumpAndSettle();

      expect(requests.map((r) => '${r.method} ${r.url.path}'), [
        'GET /v1/shares/keys',
        'PUT /v1/shares/keys/me',
        'POST /v1/shares/users',
      ]);
      final body = jsonDecode(requests.last.body) as Map<String, dynamic>;
      expect(body['recipientPublicKey'], 'their-key');
      expect(body['blob']['kid'], 'share-box');
      expect(find.textContaining('Shared with jayesh@zymr.com'), findsOneWidget);
      expect(state.account!.sharingPins, {'jayesh@zymr.com': 'their-key'});
    });
  });

  testWidgets('shares a project secret only where this account can read it', (tester) async {
    tester.view
      ..devicePixelRatio = 1
      ..physicalSize = const Size(412, 1400);
    addTearDown(tester.view.reset);
    final requests = <http.Request>[];
    final core = FakeCore(values: {'blob-db-dev': 'postgres://dev'});
    final state = unlockedState(core)
      ..api = ZvaultApi(
        'https://zvault.example',
        token: 'token',
        client: MockClient((req) async {
          requests.add(req);
          return http.Response('{"unverifiedEmails":[]}', 201);
        }),
      );
    await tester.pumpWidget(ZvaultApp(state: state));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('tab-projects')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Payments API'));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('env-prod')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('share-secret-DATABASE_URL')), findsNothing);

    await tester.tap(find.byKey(const Key('env-dev')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('share-secret-DATABASE_URL')));
    await tester.pumpAndSettle();
    expect(find.text('Payments API / Development value, encrypted on this phone'), findsOneWidget);

    await tester.tap(find.byKey(const Key('share-create-link')));
    await tester.pumpAndSettle();

    final shared = core.sharedSecrets.single;
    expect(
      [shared.projectId, shared.secretId, shared.environmentId, shared.valueJson, shared.key],
      ['p1', 's1', 'dev', 'blob-db-dev', 'DATABASE_URL'],
    );
    expect(shared.environmentName, 'Development');
    expect(requests.single.url.path, '/v1/shares/links');
    expect(requests.single.body, isNot(contains('postgres://dev')));
    expect(requests.single.body, isNot(contains('linkkey')));
    expect(find.textContaining('Anyone with this link can view the secret'), findsOneWidget);
  });

  group('ZvaultApi', () {
    test('reads an approved pairing', () async {
      final api = ZvaultApi(
        'https://zvault.example/',
        client: MockClient((req) async {
          expect(req.url.toString(), 'https://zvault.example/v1/pairings/abc/result');
          return http.Response(
            '{"status":"approved","sessionToken":"t","expiresAt":"2026-01-01T00:00:00Z",'
            '"grant":{"ephemeralPublicKey":"e","nonce":"n","ct":"c"}}',
            200,
          );
        }),
      );
      final result = await api.pairingResult('abc', claimToken: 'x');
      expect(result, isA<PairingApproved>());
      expect((result as PairingApproved).grant.ct, 'c');
    });

    test('explains an expired code', () async {
      final api = ZvaultApi(
        'https://zvault.example',
        client: MockClient((_) async => http.Response('{"message":"Not Found"}', 404)),
      );
      expect(
        () => api.claimPairing(
          'abc',
          claimToken: 'x',
          publicKey: 'p',
          device: const DeviceInfo(name: 'n', platform: 'android', appVersion: '0.1.0'),
        ),
        throwsA(isA<ApiException>().having((e) => e.message, 'message', contains('expired'))),
      );
    });
  });
}
