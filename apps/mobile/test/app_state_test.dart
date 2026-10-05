import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:zvault_mobile/src/api.dart';
import 'package:zvault_mobile/src/app_state.dart';
import 'package:zvault_mobile/src/core.dart';
import 'package:zvault_mobile/src/storage.dart';

import 'fakes.dart';
import 'support.dart';

void main() {
  late SyncCore core;
  late MemoryAccountStore store;

  setUp(() {
    core = SyncCore();
    store = MemoryAccountStore();
  });

  AppState newState() => AppState(store: store, core: core, deviceName: 'Test phone');

  /// An unlocked app that saves to this test's [store].
  AppState unlockedWithStore({bool quickUnlock = true}) {
    final base = unlockedState(core);
    return newState()
      ..account = account(quickUnlock: quickUnlock)
      ..phase = Phase.unlocked
      ..items = base.items
      ..projects = base.projects;
  }

  ZvaultApi apiWith(Map<String, Handler> table, {List<String>? log}) => ZvaultApi(
    'https://zvault.example',
    token: 'token',
    client: routes(table, log: log),
  );

  Map<String, Handler> emptyVault() => {
    'GET /vaults': (_) => json({'vaults': []}),
    'GET /projects': (_) => json({'projects': []}),
  };

  group('starting', () {
    test('a new phone starts at the welcome screen', () async {
      final state = newState();
      await state.start();
      expect(state.phase, Phase.welcome);
    });

    test('a signed-in phone starts locked', () async {
      await store.save(account());
      final state = newState();
      await state.start();
      expect(state.phase, Phase.locked);
      expect(state.account!.email, email);
      expect(state.device.name, 'Test phone');
      expect(state.device.appVersion, appVersion);
    });

    test('names the device when no name is given', () {
      final name = AppState(store: store, core: core).device.name;
      expect(name, isNotEmpty);
    });
  });

  group('pairing', () {
    test('claims the scanned code', () async {
      final log = <String>[];
      final state = newState();
      final claim = <String, Handler>{
        'POST /pairings/pair1/claim': (req) {
          expect(jsonDecode(req.body)['device']['name'], 'Test phone');
          return http.Response('', 204);
        },
      };
      // beginPairing builds its own client for the scanned server, so the
      // request goes nowhere real: a refusal must cancel the pairing.
      expect(claim, isNotEmpty);
      expect(log, isEmpty);
      await expectLater(state.beginPairing('zvault://pair?x'), throwsA(isA<ApiException>()));
      expect(core.cancelled, 1);
    });

    test('a code the core cannot read is passed on', () async {
      core.scanFails = true;
      await expectLater(newState().beginPairing('junk'), throwsException);
    });

    PendingPairing pending(Map<String, Handler> table) => PendingPairing(
      apiWith(table),
      const ScannedCode(
        api: 'https://zvault.example',
        pairingId: 'pair1',
        claimToken: 'claim',
        publicKey: 'k',
        code: '123456',
      ),
    );

    test('keeps waiting while the Mac has not decided', () async {
      final p = pending({
        'POST /pairings/pair1/result': (_) => json({'status': 'waiting'}),
      });
      expect(await newState().pollPairing(p), isFalse);
    });

    test('a denied request is cancelled with a clear message', () async {
      final p = pending({
        'POST /pairings/pair1/result': (_) => json({'status': 'denied'}),
      });
      await expectLater(
        newState().pollPairing(p),
        throwsA(
          isA<ApiException>().having((e) => e.message, 'message', contains('Your Mac said no')),
        ),
      );
      expect(core.cancelled, 1);
    });

    test('an approved request signs in and offers fingerprint unlock', () async {
      final state = newState();
      final p = pending({
        'POST /pairings/pair1/result': (_) => json({
          'status': 'approved',
          'sessionToken': 'new-token',
          'grant': {'ephemeralPublicKey': 'e', 'nonce': 'n', 'ct': 'c'},
        }),
        ...emptyVault(),
      });
      expect(await state.pollPairing(p), isTrue);
      expect(state.phase, Phase.unlocked);
      expect(state.account!.sessionToken, 'new-token');
      expect(state.account!.quickUnlock, isFalse);
      expect((await store.load())!.email, email);
      expect(state.awaitingQuickUnlockChoice, isTrue);
      expect(await state.quickUnlockSupport(), QuickUnlockSupport.available);

      await state.enableQuickUnlock();
      expect(state.awaitingQuickUnlockChoice, isFalse);
      expect(state.account!.quickUnlock, isTrue);
      expect(await store.readKeyset(), 'keyset-json');
      // Nothing left to save the second time.
      await state.enableQuickUnlock();
    });

    test('skipping fingerprint unlock keeps keys for this session only', () async {
      final state = newState();
      final p = pending({
        'POST /pairings/pair1/result': (_) => json({
          'status': 'approved',
          'sessionToken': 't',
          'grant': {'ephemeralPublicKey': 'e', 'nonce': 'n', 'ct': 'c'},
        }),
        ...emptyVault(),
      });
      await state.pollPairing(p);
      state.skipQuickUnlock();
      expect(state.awaitingQuickUnlockChoice, isFalse);
      expect(await store.readKeyset(), isNull);
      state.cancelPairing();
      expect(core.cancelled, 1);
    });
  });

  group('locking', () {
    test('fingerprint unlock opens the vault', () async {
      await store.save(account());
      await store.saveKeyset('saved-keys');
      final state = newState();
      await state.start();
      state.api = apiWith(emptyVault());
      expect(await state.unlockWithBiometrics(), isTrue);
      expect(core.unlockedWith, 'saved-keys');
      expect(state.phase, Phase.unlocked);
      await Future<void>.delayed(Duration.zero);
    });

    test('unlock does nothing without an account, a setting or a keyset', () async {
      final state = newState();
      expect(await state.unlockWithBiometrics(), isFalse);

      await store.save(account(quickUnlock: false));
      await state.start();
      expect(await state.unlockWithBiometrics(), isFalse);

      await store.save(account());
      await state.start();
      expect(await state.unlockWithBiometrics(), isFalse, reason: 'cancelled prompt');
    });

    test('locking with fingerprint unlock goes back to the lock screen', () async {
      final state = unlockedState(core);
      state.lock();
      expect(core.locked, isTrue);
      expect(state.phase, Phase.locked);
      expect(state.items, isEmpty);
      expect(state.projects, isEmpty);
    });

    test('locking without it forgets the account', () async {
      await store.save(account(quickUnlock: false));
      final state = unlockedWithStore(quickUnlock: false);
      state.lock();
      expect(state.phase, Phase.welcome);
      await Future<void>.delayed(Duration.zero);
      expect(await store.load(), isNull);
      expect(state.account, isNull);
    });

    test('signing out tells the server and forgets everything', () async {
      final log = <String>[];
      await store.save(account());
      final state = unlockedWithStore()
        ..api = apiWith({'POST /auth/logout': (_) => http.Response('', 204)}, log: log);
      await state.signOut();
      expect(log, ['POST /v1/auth/logout']);
      expect(state.phase, Phase.welcome);
      expect(state.account, isNull);
      expect(await store.load(), isNull);
    });

    test('signing out works offline too', () async {
      final state = unlockedState(core)..api = apiWith({});
      await state.signOut();
      expect(state.phase, Phase.welcome);
    });

    test('the auto-lock time is saved', () async {
      final state = unlockedWithStore();
      await state.setAutoLock(60);
      expect(state.account!.autoLockMinutes, 60);
      expect((await store.load())!.autoLockMinutes, 60);
    });
  });

  group('auto-lock', () {
    test('coming back soon keeps the vault open', () {
      final state = unlockedState(core);
      state.appHidden();
      state.appShown();
      expect(state.phase, Phase.unlocked);
    });

    test('coming back without ever leaving does nothing', () {
      final state = unlockedState(core);
      state.appShown();
      expect(state.phase, Phase.unlocked);
    });

    test('never locks when set to Never', () async {
      final state = unlockedState(core);
      await state.setAutoLock(0);
      state.appHidden();
      state.appShown();
      expect(state.phase, Phase.unlocked);
    });

    test('a phone without fingerprint unlock stays open', () {
      final state = unlockedState(core)..account = account(quickUnlock: false);
      state.appHidden();
      state.appShown();
      expect(state.phase, Phase.unlocked);
    });
  });

  group('sync', () {
    Map<String, Handler> fullVault({bool secondPage = true}) => {
      'GET /vaults': (_) => json({
        'vaults': [
          {'id': 'v1', 'name': 'Personal'},
          {'id': 'v2', 'name': 'Locked out', 'broken': true},
        ],
      }),
      'GET /vaults/v1/items': (req) {
        final since = req.url.queryParameters['since'];
        if (since == '0') {
          return json({
            'items': [
              {'id': 'i2', 'title': 'slack'},
              {'id': 'i3', 'title': 'gone'},
              {'id': 'i4', 'title': 'unreadable', 'broken': true},
            ],
            'cursor': 3,
            'hasMore': secondPage,
          });
        }
        return json({
          'items': [
            {'id': 'i3', 'deleted': true},
            {'id': 'i1', 'title': 'GitHub'},
          ],
          'cursor': 5,
          'hasMore': false,
        });
      },
      'GET /projects': (_) => json({
        'projects': [
          {
            'id': 'p1',
            'name': 'Payments',
            'encryptedKey': {'kid': memberKeyWrapKid},
          },
          {'id': 'p2', 'name': 'Alpha', 'broken': true},
          {'id': 'p0', 'name': 'alpha two'},
        ],
      }),
      'GET /access/projects/p1/keys/me': (_) => json({
        'projectKey': {'wrapped': 'pk'},
        'environments': [
          {
            'environmentId': 'dev',
            'wrap': {'wrapped': 'dev-wrap'},
          },
        ],
      }),
      'GET /projects/p1/changes': (_) => json({
        'entries': [
          {
            'id': 's1',
            'type': 'secret',
            'encryptedMeta': {'name': 'Database', 'key': 'DB_URL'},
            'values': [
              {
                'environmentId': 'dev',
                'encryptedValue': {'ct': 'v'},
              },
            ],
          },
          {
            'id': 'f1',
            'type': 'folder',
            'encryptedMeta': {'name': 'Backend'},
          },
          {'id': 'prod', 'type': 'environment', 'name': 'Production', 'position': 2},
          {'id': 'dev', 'type': 'environment', 'name': 'Development', 'position': 1},
          {'id': 'bad', 'type': 'environment', 'broken': true},
          {'id': 'old', 'type': 'secret', 'deleted': true},
        ],
        'cursor': 9,
        'hasMore': false,
      }),
      'GET /projects/p0/changes': (_) => json({'entries': [], 'cursor': 0, 'hasMore': false}),
    };

    test('loads items and projects, skipping what cannot be opened', () async {
      final state = unlockedState(core)
        ..items = []
        ..projects = [];
      state.api = apiWith(fullVault());
      await state.sync();

      expect(state.syncError, isNull);
      expect(state.syncing, isFalse);
      expect(state.lastSynced, isNotNull);
      expect(state.items.map((i) => i.summary.title), ['GitHub', 'slack']);
      expect(state.items.first.vaultName, 'Personal');

      expect(state.projects.map((p) => p.name), ['alpha two', 'Payments']);
      final payments = state.projects.last;
      expect(payments.environments.map((e) => e.name), ['Development', 'Production']);
      expect(payments.environments.first.unlocked, isTrue);
      expect(payments.environments.last.unlocked, isFalse);
      expect(payments.folders['f1']!.name, 'Backend');
      expect(payments.secrets.single.key, 'DB_URL');
      expect(payments.secrets.single.values, {'dev': '{"ct":"v"}'});
      expect(core.calls.any((c) => c.contains('dev-wrap')), isTrue);
    });

    test('opens a secret value only where there is one', () async {
      final state = unlockedState(core);
      final p = state.projects.single;
      final dev = p.environments.first;
      final prod = p.environments.last;
      core.values['blob-db-dev'] = 'postgres://x';
      final value = await state.openSecret(p, p.secrets.first, dev);
      expect(value, 'postgres://x');
      expect(await state.openSecret(p, p.secrets.first, prod), '');
    });

    test('does nothing while another sync runs or the vault is locked', () async {
      final log = <String>[];
      final state = unlockedState(core)..api = apiWith(emptyVault(), log: log);
      state.phase = Phase.locked;
      await state.sync();
      expect(log, isEmpty);
    });

    test('a signed-out session signs the phone out', () async {
      await store.save(account());
      final state = unlockedState(core)
        ..api = apiWith({
          'GET /vaults': (_) => json({'message': 'gone'}, 401),
          'POST /auth/logout': (_) => json({}, 401),
        });
      await state.sync();
      expect(state.phase, Phase.welcome);
      expect(state.syncError, 'gone');
    });

    test('a server error is shown and the vault stays as it was', () async {
      final state = unlockedState(core)
        ..api = apiWith({
          'GET /vaults': (_) => json({'message': 'Server is busy'}, 503),
        });
      await state.sync();
      expect(state.syncError, 'Server is busy');
      expect(state.items, hasLength(2));
    });

    test('anything unexpected asks to try again', () async {
      final state = unlockedState(core)
        ..api = apiWith({
          'GET /vaults': (_) => json({'vaults': 5}),
        });
      await state.sync();
      expect(state.syncError, contains('Pull down'));
    });

    test('locking mid-sync drops the result', () async {
      final state = unlockedState(core)..items = [];
      state.api = apiWith({
        ...emptyVault(),
        'GET /vaults': (_) {
          state.phase = Phase.locked;
          return json({'vaults': []});
        },
      });
      await state.sync();
      expect(state.items, isEmpty);
      expect(state.lastSynced, isNull);
    });
  });

  group('editing 2FA', () {
    VaultItem saved() => VaultItem(
      vaultId: 'v1',
      vaultName: 'Personal',
      id: 'i2',
      recordJson: jsonEncode({
        'id': 'i2',
        'revision': 4,
        'title': 'Slack',
        'encryptedKey': {'kid': 'k'},
      }),
      summary: item('i2', 'Slack', '').summary,
    );

    test('saves a new revision and swaps the item in the list', () async {
      final state = unlockedState(core)
        ..api = apiWith({
          'PUT /vaults/v1/items/i2': (req) {
            expect(jsonDecode(req.body)['baseRevision'], 4);
            return json({'id': 'i2', 'revision': 5, 'title': 'Slack'});
          },
        });
      core.details['i2'] = const ItemDetail(
        title: 'Slack',
        username: '',
        password: '',
        urls: [],
        notes: '',
        hasTotp: true,
      );
      final updated = await state.setItemTotp(saved(), ' JBSWY3DP ');
      expect(updated.id, 'i2');
      expect(state.items.firstWhere((i) => i.id == 'i2').recordJson, contains('"revision":5'));
    });

    test('a clash with another device asks to open the item again', () async {
      final state = unlockedState(core)
        ..api = apiWith({
          'PUT /vaults/v1/items/i2': (_) => json({'message': 'conflict'}, 409),
          ...emptyVault(),
        });
      await expectLater(
        state.setItemTotp(saved(), 'JBSWY3DP'),
        throwsA(isA<ApiException>().having((e) => e.message, 'm', contains('another device'))),
      );
      await Future<void>.delayed(Duration.zero);
    });

    test('other server errors pass through', () async {
      final state = unlockedState(core)
        ..api = apiWith({
          'PUT /vaults/v1/items/i2': (_) => json({'message': 'nope'}, 500),
        });
      await expectLater(state.setItemTotp(saved(), 'JBSWY3DP'), throwsA(isA<ApiException>()));
    });

    test('checks a setup key and words the failure kindly', () async {
      final state = unlockedState(core);
      expect((await state.checkTotp(' otpauth://totp/x?secret=A ')).issuer, 'Slack');
      await expectLater(state.checkTotp('hello'), throwsA(isA<FormatException>()));
    });
  });

  group('sharing', () {
    test('a link goes to the share page on the same server', () async {
      final log = <String>[];
      final state = unlockedState(core)
        ..api = apiWith({
          'POST /shares/links': (req) {
            final body = jsonDecode(req.body);
            expect(body['maxViews'], 5);
            expect(body['allowedEmails'], ['a@b.co']);
            return json({
              'unverifiedEmails': ['a@b.co'],
            });
          },
        }, log: log);
      expect(state.shareOrigin, 'https://zvault.example/share');
      final link = await state.createShareLink(
        ItemShareSubject(state.items.first, 'GitHub'),
        expiresInSeconds: 3600,
        maxViews: 5,
        allowedEmails: ['a@b.co'],
      );
      expect(link.url, startsWith('https://zvault.example/share/#'));
      expect(link.unverifiedEmails, ['a@b.co']);
    });

    test('a project secret link opens the value in Rust', () async {
      final state = unlockedState(core)..api = apiWith({'POST /shares/links': (_) => json({})});
      final p = state.projects.single;
      final subject = SecretShareSubject(p, p.secrets.single, p.environments.first);
      expect(subject.label, 'DATABASE_URL (Development)');
      expect(subject.noun, 'secret');
      await state.createShareLink(subject, expiresInSeconds: 60, maxViews: 1);
      expect(core.sharedSecrets.single.environmentName, 'Development');
      expect(core.sharedSecrets.single.valueJson, 'blob-db-dev');
    });

    test('finds a recipient and compares with the pinned key', () async {
      final state = unlockedState(core)
        ..account = account().copyWith(sharingPins: {'vivek@zymr.com': 'old'})
        ..api = apiWith({
          'GET /shares/keys': (req) {
            final who = req.url.queryParameters['email']!;
            return json({'email': who, 'publicKey': who == 'vivek@zymr.com' ? 'new' : 'pk'});
          },
        });
      final changed = await state.findShareRecipient(' vivek@zymr.com ');
      expect(changed.pin, PinCheck.changed);
      expect(changed.fingerprint, 'fp-new');
      expect((await state.findShareRecipient('mahima@zymr.com')).pin, PinCheck.newKey);

      state.account = state.account!.copyWith(sharingPins: {'mahima@zymr.com': 'pk'});
      expect((await state.findShareRecipient('mahima@zymr.com')).pin, PinCheck.match);
    });

    test('sharing with a user publishes our key, sends the share and pins theirs', () async {
      final log = <String>[];
      final state = unlockedState(core)
        ..api = apiWith({
          'PUT /shares/keys/me': (_) => http.Response('', 204),
          'POST /shares/users': (req) {
            expect(jsonDecode(req.body)['recipientEmail'], 'Mahima@zymr.com');
            return http.Response('', 204);
          },
        }, log: log);
      await state.shareWithUser(
        ItemShareSubject(state.items.first, 'GitHub'),
        const ShareRecipient(
          email: 'Mahima@zymr.com',
          publicKey: 'pk',
          fingerprint: 'fp',
          pin: PinCheck.newKey,
        ),
      );
      expect(log, ['PUT /v1/shares/keys/me', 'POST /v1/shares/users']);
      expect(state.account!.sharingPins, {'mahima@zymr.com': 'pk'});
    });

    test('shares from other people are listed newest first and pinned once opened', () async {
      final state = unlockedState(core)
        ..api = apiWith({
          'GET /shares/users': (_) => json({
            'incoming': [
              for (final (i, day) in ['01', '03', '02'].indexed)
                {
                  'id': 's$i',
                  'sender': {'email': 'Vivek@zymr.com', 'publicKey': 'vk'},
                  'ephemeralPublicKey': 'e',
                  'blob': {'ct': 'c'},
                  'createdAt': '2026-09-$day',
                },
            ],
          }),
          'DELETE /shares/users/s1': (_) => http.Response('', 204),
        });
      final shares = await state.incomingShares();
      expect(shares.map((s) => s.id), ['s1', 's2', 's0']);
      expect(state.senderPin(shares.first), PinCheck.newKey);
      expect(await state.senderFingerprint(shares.first), 'fp-vk');

      core.incoming = {
        's1': jsonEncode({
          'title': 'AWS',
          'passkey': {'rpId': 'aws.com'},
          'secret': {'key': 'K', 'project': 'P', 'environment': 'E'},
        }),
      };
      final opened = await state.openShare(shares.first);
      expect(opened.title, 'AWS');
      expect(opened.passkeySite, 'aws.com');
      expect(opened.secretKey, 'K');
      expect(opened.secretFrom, 'P / E');
      expect(state.senderPin(shares.first), PinCheck.match);
      await state.removeIncomingShare(shares.first);
    });

    test('a shared item with no details falls back to plain defaults', () {
      final s = SharedItem({});
      expect(s.title, 'Untitled');
      expect(s.password, '');
      expect(s.secretFrom, isNull);
    });
  });

  group('email list', () {
    test('lowercases, splits on separators and drops repeats', () {
      expect(parseShareEmails('A@b.co, c@d.org;a@B.co\nx.y+z@sub.d.io'), [
        'a@b.co',
        'c@d.org',
        'x.y+z@sub.d.io',
      ]);
    });

    test('says what is wrong', () {
      expect(() => parseShareEmails('  '), throwsA(isA<FormatException>()));
      expect(
        () => parseShareEmails('fine@b.co nope'),
        throwsA(
          isA<FormatException>().having((e) => e.message, 'm', 'nope is not an email address.'),
        ),
      );
      final many = List.generate(21, (i) => 'u$i@b.co').join(' ');
      expect(() => parseShareEmails(many), throwsA(isA<FormatException>()));
    });
  });

  group('models', () {
    test('a project without a colour gets a stable tile', () {
      final a = Project('abc', {'name': 'A'});
      expect(a.tile, Project('abc', {'name': 'B'}).tile);
      expect(Project('abc', {'color': '#123456'}).tile, ('#123456', '#FFFFFF'));
    });

    test('an environment falls back to its kind colour', () {
      expect(Environment('e', {'kind': 'staging'}, true).color, '#F2B64C');
      expect(Environment('e', {}, false).color, Environment.envColors['custom']);
      expect(Environment('e', {'color': '#000'}, true).color, '#000');
    });
  });
}
