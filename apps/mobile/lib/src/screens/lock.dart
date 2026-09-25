import 'dart:io';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app_state.dart';
import '../theme.dart';
import '../widgets.dart';

/// Signed in, keys behind the fingerprint sensor. Prompts on open.
class LockScreen extends StatefulWidget {
  const LockScreen({super.key});

  @override
  State<LockScreen> createState() => _LockScreenState();
}

class _LockScreenState extends State<LockScreen> {
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    // Phones ask for the fingerprint right away. The desktop build keeps the
    // keyset in memory with no prompt, so it waits for a tap instead.
    if (Platform.isAndroid || Platform.isIOS) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _unlock());
    }
  }

  Future<void> _unlock() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final ok = await context.read<AppState>().unlockWithBiometrics();
      if (!ok && mounted) setState(() => _error = 'Unlock was cancelled.');
    } catch (_) {
      if (mounted) {
        setState(() => _error = "Couldn't unlock. Try again, or sign in again with your Mac.");
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final app = context.watch<AppState>();
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 24, 24, 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Spacer(flex: 3),
              const Center(child: BrandMark(size: 56, halo: true)),
              const SizedBox(height: 28),
              Text('Zvault is locked', textAlign: TextAlign.center, style: t.headlineMedium),
              const SizedBox(height: 8),
              Text(
                app.account?.email ?? '',
                textAlign: TextAlign.center,
                style: t.bodyLarge?.copyWith(color: Zv.text2),
              ),
              const Spacer(flex: 2),
              Center(
                child: InkResponse(
                  key: const Key('unlock-fingerprint'),
                  onTap: _busy ? null : _unlock,
                  radius: 56,
                  child: Container(
                    width: 88,
                    height: 88,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: Zv.irisRing,
                      border: Border.all(color: Zv.lineStrong, width: 1.5),
                    ),
                    child: const Icon(Icons.fingerprint_rounded, size: 48, color: Zv.irisText),
                  ),
                ),
              ),
              const SizedBox(height: 14),
              const Text(
                'Touch the sensor to unlock',
                textAlign: TextAlign.center,
                style: TextStyle(color: Zv.text2, fontSize: 14),
              ),
              if (_error != null) ...[const SizedBox(height: 20), ErrorBanner(_error!)],
              const Spacer(flex: 3),
              TextButton(
                onPressed: _busy ? null : app.signOut,
                child: const Text('Sign in with a different account'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
