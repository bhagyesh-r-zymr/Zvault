import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:zvault_mobile/src/storage.dart';

import 'fakes.dart';

void main() {
  group('SavedAccount', () {
    test('survives a round trip through JSON', () {
      final a = account().copyWith(autoLockMinutes: 60, sharingPins: {'a@b.co': 'key'});
      final back = SavedAccount.fromJson(jsonEncode(a.toJson()))!;
      expect(back.email, email);
      expect(back.api, 'https://zvault.example');
      expect(back.sessionToken, 'token');
      expect(back.quickUnlock, isTrue);
      expect(back.autoLockMinutes, 60);
      expect(back.sharingPins, {'a@b.co': 'key'});
    });

    test('fills defaults for fields older versions did not save', () {
      final a = SavedAccount.fromJson('{"api":"x","email":"e","sessionToken":"t"}')!;
      expect(a.quickUnlock, isFalse);
      expect(a.autoLockMinutes, defaultAutoLockMinutes);
      expect(a.sharingPins, isEmpty);
    });

    test('treats missing or damaged text as no account', () {
      expect(SavedAccount.fromJson(null), isNull);
      expect(SavedAccount.fromJson(''), isNull);
      expect(SavedAccount.fromJson('not json'), isNull);
      expect(SavedAccount.fromJson('{"api":"x"}'), isNull);
    });

    test('copyWith changes only what it is given', () {
      final a = account(quickUnlock: false);
      final b = a.copyWith(quickUnlock: true);
      expect(b.quickUnlock, isTrue);
      expect(b.email, a.email);
      expect(b.autoLockMinutes, a.autoLockMinutes);
      expect(a.copyWith().quickUnlock, isFalse);
    });
  });

  group('MemoryAccountStore', () {
    test('keeps the account and keyset until cleared', () async {
      final store = MemoryAccountStore();
      expect(await store.load(), isNull);
      expect(await store.readKeyset(), isNull);
      expect(await store.quickUnlockSupport(), QuickUnlockSupport.available);

      await store.save(account());
      await store.saveKeyset('keys');
      expect((await store.load())!.email, email);
      expect(await store.readKeyset(), 'keys');

      await store.clear();
      expect(await store.load(), isNull);
      expect(await store.readKeyset(), isNull);
    });

    test('is what a desktop build uses', () {
      expect(defaultAccountStore(), isA<MemoryAccountStore>());
    });
  });
}
