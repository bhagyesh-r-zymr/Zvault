import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
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
