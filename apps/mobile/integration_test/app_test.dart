// Runs on a real (emulated) Android device with the real Rust core, so it
// covers what widget tests fake: the native library loads, the bridge works,
// and the app's first screens run on Android.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:zvault_mobile/main.dart';
import 'package:zvault_mobile/src/app_state.dart';
import 'package:zvault_mobile/src/core.dart';
import 'package:zvault_mobile/src/rust/api/session.dart' as session;
import 'package:zvault_mobile/src/rust/api/vault.dart' as vault;
import 'package:zvault_mobile/src/rust/frb_generated.dart';
import 'package:zvault_mobile/src/storage.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    await RustLib.init();
  });

  group('Rust core', () {
    test('computes the RFC 6238 test code', () async {
      // The RFC's secret "12345678901234567890" at Unix time 59.
      final code = await vault.totpCode(
        uri: 'otpauth://totp/Test:a@b.co?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Test',
        unixSecs: 59,
      );
      expect(code.code, '287082');
      expect(code.period, 30);
      expect(code.remaining, 1);
    });

    test('reads a setup key and names the account', () async {
      final setup = await const Core().checkTotp(
        'otpauth://totp/GitHub:meet@zymr.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub',
      );
      expect(setup.issuer, 'GitHub');
      expect(setup.account, 'meet@zymr.com');
      expect(setup.current.code, hasLength(6));
    });

    test('rejects a code that is not a sign-in code', () async {
      await expectLater(const Core().scan('https://example.com'), throwsA(anything));
    });

    test('unlocks with a keyset and wipes it on lock', () async {
      final keyset = base64Url.encode(List.filled(32, 7)).replaceAll('=', '');
      await const Core().unlock('meet@zymr.com', keyset);
      expect(session.unlockedEmail(), 'meet@zymr.com');

      final identity = await const Core().sharingIdentity();
      expect(identity.publicKey, isNotEmpty);
      expect(await const Core().sharingFingerprint(identity.publicKey), identity.fingerprint);

      const Core().lock();
      expect(session.unlockedEmail(), isNull);
    });
  });

  group('app', () {
    testWidgets('a new phone asks to scan the QR code', (tester) async {
      final state = AppState(store: MemoryAccountStore());
      await state.start();
      await tester.pumpWidget(ZvaultApp(state: state));
      await tester.pumpAndSettle();
      expect(find.text('Sign in with QR code'), findsOneWidget);
    });

    testWidgets('pasting something that is not a sign-in code explains what to do', (tester) async {
      final state = AppState(store: MemoryAccountStore());
      await state.start();
      await tester.pumpWidget(ZvaultApp(state: state));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('paste')));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('code-field')), 'hello');
      await tester.tap(find.byKey(const Key('code-continue')));
      await tester.pumpAndSettle();

      expect(find.textContaining("isn't a Zvault sign-in code"), findsOneWidget);
    });

    testWidgets('a saved account opens on the lock screen', (tester) async {
      final store = MemoryAccountStore();
      await store.save(
        const SavedAccount(
          api: 'https://zvault.example',
          email: 'meet@zymr.com',
          sessionToken: 't',
          quickUnlock: true,
        ),
      );
      final state = AppState(store: store);
      await state.start();
      await tester.pumpWidget(ZvaultApp(state: state));
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('Zvault is locked'), findsOneWidget);
      expect(find.text('meet@zymr.com'), findsOneWidget);
    });
  });
}
