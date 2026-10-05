import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:zvault_mobile/main.dart';
import 'package:zvault_mobile/src/api.dart';
import 'package:zvault_mobile/src/app_state.dart';
import 'package:zvault_mobile/src/core.dart';
import 'package:zvault_mobile/src/storage.dart';

import 'fakes.dart';
import 'support.dart';

/// A store whose biometric prompt can be cancelled or fail.
class PromptStore extends MemoryAccountStore {
  bool cancel = false;
  bool fail = false;
  QuickUnlockSupport support = QuickUnlockSupport.available;
  bool failSave = false;

  @override
  Future<String?> readKeyset() async {
    if (fail) throw Exception('sensor broke');
    return cancel ? null : super.readKeyset();
  }

  @override
  Future<QuickUnlockSupport> quickUnlockSupport() async => support;

  @override
  Future<void> saveKeyset(String keyset) async {
    if (failSave) throw Exception('keystore');
    await super.saveKeyset(keyset);
  }
}

void tall(WidgetTester tester) {
  tester.view.physicalSize = const Size(1700, 2400);
  tester.view.devicePixelRatio = 2.75;
  addTearDown(tester.view.reset);
}

/// Tears the app down. The pairing screen reads Provider in `dispose`, which
/// debug builds flag when the tree is unmounted; release builds don't check.
Future<void> closeApp(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  tester.takeException();
}

void main() {
  group('welcome', () {
    testWidgets('pasting a code starts pairing and shows a failure with a way back', (
      tester,
    ) async {
      tall(tester);
      final state = AppState(store: MemoryAccountStore(), core: SyncCore());
      await state.start();
      await http.runWithClient(
        () async {
          await tester.pumpWidget(ZvaultApp(state: state));
          await tester.pumpAndSettle();
          expect(find.text('Settings'), findsOneWidget);
          expect(find.text('Devices'), findsOneWidget);

          await tester.tap(find.byKey(const Key('paste')));
          await tester.pumpAndSettle();
          expect(find.text('Paste a sign-in code'), findsOneWidget);
          await tester.enterText(find.byKey(const Key('code-field')), '  zvault://pair?x  ');
          await tester.tap(find.byKey(const Key('code-continue')));
          await tester.pumpAndSettle();

          // The server refuses the claim, so the screen explains and offers to try again.
          expect(find.text('Sign in'), findsOneWidget);
          expect(find.text('Scan again'), findsOneWidget);
          await tester.tap(find.text('Scan again'));
          await tester.pumpAndSettle();
          tester.takeException();
          expect(find.text('Sign in with QR code'), findsOneWidget);
        },
        () => routes({
          'POST /pairings/pair1/claim': (_) => json({'message': 'Code used'}, 409),
        }),
      );
    });

    testWidgets('a code the core cannot read is explained', (tester) async {
      tall(tester);
      final core = SyncCore()..scanFails = true;
      final state = AppState(store: MemoryAccountStore(), core: core);
      await state.start();
      await tester.pumpWidget(ZvaultApp(state: state));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('paste')));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('code-field')), 'junk');
      await tester.tap(find.byKey(const Key('code-continue')));
      await tester.pumpAndSettle();
      expect(find.textContaining('bad code'), findsOneWidget);
      await closeApp(tester);
    });
  });

  group('pairing', () {
    Map<String, Handler> mac(String status) => {
      'POST /pairings/pair1/claim': (_) => http.Response('', 204),
      'POST /pairings/pair1/result': (_) => status == 'approved'
          ? json({
              'status': 'approved',
              'sessionToken': 'tok',
              'grant': {'ephemeralPublicKey': 'e', 'nonce': 'n', 'ct': 'c'},
            })
          : json({'status': status}),
      'GET /vaults': (_) => json({'vaults': []}),
      'GET /projects': (_) => json({'projects': []}),
    };

    Future<void> startPairing(WidgetTester tester, AppState state) async {
      await state.start();
      await tester.pumpWidget(ZvaultApp(state: state));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('paste')));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('code-field')), 'zvault://pair?x');
      await tester.tap(find.byKey(const Key('code-continue')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
    }

    testWidgets('shows the code to compare while the Mac decides', (tester) async {
      tall(tester);
      final state = AppState(store: MemoryAccountStore(), core: SyncCore());
      await http.runWithClient(() async {
        await startPairing(tester, state);
        expect(find.text('Check the code'), findsOneWidget);
        expect(find.text('123 456'), findsOneWidget);
        expect(find.text('Waiting for your Mac…'), findsOneWidget);
        await tester.pump(const Duration(milliseconds: 1600));
        expect(find.text('Waiting for your Mac…'), findsOneWidget);
        await tester.pageBack();
        await tester.pumpAndSettle();
        tester.takeException();
      }, () => routes(mac('waiting')));
    });

    testWidgets('a denied request says so', (tester) async {
      tall(tester);
      final state = AppState(store: MemoryAccountStore(), core: SyncCore());
      await http.runWithClient(() async {
        await startPairing(tester, state);
        await tester.pump(const Duration(milliseconds: 1600));
        await tester.pump(const Duration(milliseconds: 100));
        expect(find.textContaining('Your Mac said no'), findsOneWidget);
        await closeApp(tester);
      }, () => routes(mac('denied')));
    });

    testWidgets('an approved request lands on the fingerprint offer', (tester) async {
      tall(tester);
      final state = AppState(store: PromptStore(), core: SyncCore());
      await http.runWithClient(() async {
        await startPairing(tester, state);
        await tester.pump(const Duration(milliseconds: 1600));
        await tester.pump(const Duration(milliseconds: 600));
        tester.takeException();
        expect(state.phase, Phase.unlocked);
        expect(find.text('Unlock with your fingerprint'), findsOneWidget);
        expect(find.text('Signed in as $email'), findsOneWidget);
        await closeApp(tester);
      }, () => routes(mac('approved')));
    });
  });

  group('fingerprint offer', () {
    Future<(AppState, PromptStore)> offer(
      WidgetTester tester, {
      QuickUnlockSupport? support,
    }) async {
      tall(tester);
      final store = PromptStore();
      if (support != null) store.support = support;
      final state = AppState(store: store, core: SyncCore())
        ..account = account(quickUnlock: false)
        ..phase = Phase.unlocked;
      // Same hand-off as a finished pairing.
      await http.runWithClient(
        () async {
          final p = PendingPairing(
            ZvaultApi('https://zvault.example'),
            const ScannedCode(
              api: 'https://zvault.example',
              pairingId: 'pair1',
              claimToken: 'claim',
              publicKey: 'k',
              code: '123456',
            ),
          );
          await state.pollPairing(p);
        },
        () => routes({
          'POST /pairings/pair1/result': (_) => json({
            'status': 'approved',
            'sessionToken': 'tok',
            'grant': {'ephemeralPublicKey': 'e', 'nonce': 'n', 'ct': 'c'},
          }),
          'GET /vaults': (_) => json({'vaults': []}),
          'GET /projects': (_) => json({'projects': []}),
        }),
      );
      await tester.pumpWidget(ZvaultApp(state: state));
      await tester.pump(const Duration(milliseconds: 100));
      return (state, store);
    }

    testWidgets('turning it on saves the keys behind the sensor', (tester) async {
      final (state, store) = await offer(tester);
      await tester.tap(find.byKey(const Key('quick-unlock-on')));
      await tester.pump(const Duration(milliseconds: 400));
      expect(state.account!.quickUnlock, isTrue);
      expect(await store.readKeyset(), 'keyset-json');
      expect(find.text('Items'), findsWidgets);
    });

    testWidgets('not now keeps the keys for this session', (tester) async {
      final (state, store) = await offer(tester);
      await tester.tap(find.byKey(const Key('quick-unlock-skip')));
      await tester.pump(const Duration(milliseconds: 400));
      expect(state.awaitingQuickUnlockChoice, isFalse);
      expect(await store.readKeyset(), isNull);
    });

    testWidgets('a failing keystore shows an error and can be retried', (tester) async {
      final (_, store) = await offer(tester);
      store.failSave = true;
      await tester.tap(find.byKey(const Key('quick-unlock-on')));
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.textContaining("Couldn't save"), findsOneWidget);
    });

    testWidgets('no enrolled fingerprint is explained and cannot be turned on', (tester) async {
      await offer(tester, support: QuickUnlockSupport.notEnrolled);
      expect(find.textContaining('Add a fingerprint'), findsOneWidget);
      expect(
        tester.widget<FilledButton>(find.byKey(const Key('quick-unlock-on'))).onPressed,
        isNull,
      );
    });

    testWidgets('a phone with no sensor says it will ask for the QR code', (tester) async {
      await offer(tester, support: QuickUnlockSupport.unsupported);
      expect(find.textContaining('no fingerprint or face unlock'), findsOneWidget);
    });
  });

  group('lock screen', () {
    Future<(AppState, PromptStore)> locked(WidgetTester tester) async {
      tall(tester);
      final store = PromptStore();
      await store.save(account());
      await store.saveKeyset('saved-keys');
      final state = AppState(store: store, core: SyncCore());
      await state.start();
      state.api = ZvaultApi('https://zvault.example', client: routes({}));
      await tester.pumpWidget(ZvaultApp(state: state));
      await tester.pumpAndSettle();
      return (state, store);
    }

    testWidgets('shows who is signed in and unlocks with a tap', (tester) async {
      final (state, _) = await locked(tester);
      expect(find.text('Zvault is locked'), findsOneWidget);
      expect(find.text(email), findsOneWidget);
      await tester.tap(find.byKey(const Key('unlock-fingerprint')));
      await tester.pump(const Duration(milliseconds: 400));
      expect(state.phase, Phase.unlocked);
    });

    testWidgets('a cancelled prompt stays locked and says so', (tester) async {
      final (state, store) = await locked(tester);
      store.cancel = true;
      await tester.tap(find.byKey(const Key('unlock-fingerprint')));
      await tester.pumpAndSettle();
      expect(state.phase, Phase.locked);
      expect(find.text('Unlock was cancelled.'), findsOneWidget);
    });

    testWidgets('a broken sensor suggests signing in again', (tester) async {
      final (_, store) = await locked(tester);
      store.fail = true;
      await tester.tap(find.byKey(const Key('unlock-fingerprint')));
      await tester.pumpAndSettle();
      expect(find.textContaining("Couldn't unlock"), findsOneWidget);
    });

    testWidgets('signing in with another account forgets this one', (tester) async {
      final (state, store) = await locked(tester);
      await tester.tap(find.text('Sign in with a different account'));
      await tester.pumpAndSettle();
      expect(state.phase, Phase.welcome);
      expect(await store.load(), isNull);
    });
  });

  group('settings', () {
    Future<(AppState, FakeCore)> settings(WidgetTester tester) async {
      tall(tester);
      final core = FakeCore();
      final state = unlockedState(core)
        ..api = ZvaultApi('https://zvault.example', client: routes({}))
        ..lastSynced = DateTime.now().subtract(const Duration(minutes: 5));
      await tester.pumpWidget(ZvaultApp(state: state));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Settings'));
      await tester.pumpAndSettle();
      return (state, core);
    }

    testWidgets('shows the account, server, version and last sync', (tester) async {
      await settings(tester);
      expect(find.text(email), findsOneWidget);
      expect(find.text('zvault.example'), findsOneWidget);
      expect(find.text(appVersion), findsOneWidget);
      expect(find.text('5 min ago'), findsOneWidget);
      expect(find.text('On'), findsOneWidget);
      expect(find.text('15 minutes'), findsOneWidget);
    });

    testWidgets('the auto-lock time can be changed', (tester) async {
      final (state, _) = await settings(tester);
      await tester.tap(find.byKey(const Key('auto-lock')));
      await tester.pumpAndSettle();
      expect(find.text('Lock after leaving Zvault for'), findsOneWidget);
      await tester.tap(find.text('1 hour'));
      await tester.pumpAndSettle();
      expect(state.account!.autoLockMinutes, 60);
      expect(find.text('1 hour'), findsOneWidget);
    });

    testWidgets('closing the picker changes nothing', (tester) async {
      final (state, _) = await settings(tester);
      await tester.tap(find.byKey(const Key('auto-lock')));
      await tester.pumpAndSettle();
      await tester.tapAt(const Offset(10, 10));
      await tester.pumpAndSettle();
      expect(state.account!.autoLockMinutes, 15);
    });

    testWidgets('Lock now locks the vault', (tester) async {
      final (state, core) = await settings(tester);
      await tester.tap(find.text('Lock now'));
      await tester.pump(const Duration(milliseconds: 400));
      expect(core.locked, isTrue);
      expect(state.phase, Phase.locked);
    });

    testWidgets('signing out asks first', (tester) async {
      final (state, _) = await settings(tester);
      await tester.ensureVisible(find.byKey(const Key('sign-out')));
      await tester.tap(find.byKey(const Key('sign-out')));
      await tester.pumpAndSettle();
      expect(find.text('Sign out of this phone?'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(state.phase, Phase.unlocked);

      await tester.tap(find.byKey(const Key('sign-out')));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(TextButton, 'Sign out'));
      await tester.pumpAndSettle();
      expect(state.phase, Phase.welcome);
    });
  });
}
