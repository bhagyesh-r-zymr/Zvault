import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app_state.dart';
import '../storage.dart';
import '../theme.dart';
import '../widgets.dart';

/// Right after signing in: keep the keys behind the fingerprint sensor.
class QuickUnlockScreen extends StatefulWidget {
  const QuickUnlockScreen({super.key});

  @override
  State<QuickUnlockScreen> createState() => _QuickUnlockScreenState();
}

class _QuickUnlockScreenState extends State<QuickUnlockScreen> {
  QuickUnlockSupport? _support;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    context.read<AppState>().quickUnlockSupport().then((s) {
      if (mounted) setState(() => _support = s);
    });
  }

  Future<void> _turnOn() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await context.read<AppState>().enableQuickUnlock();
    } catch (_) {
      if (mounted) setState(() => _error = "Couldn't save your fingerprint unlock. Try again.");
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final app = context.watch<AppState>();
    final support = _support;
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 24, 24, 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Spacer(flex: 2),
              Center(
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                  decoration: BoxDecoration(
                    color: context.zv.okSoft,
                    borderRadius: BorderRadius.circular(99),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.check_circle_rounded, size: 16, color: context.zv.ok),
                      const SizedBox(width: 6),
                      Text(
                        'Signed in as ${app.account?.email ?? ''}',
                        style: TextStyle(
                          color: context.zv.ok,
                          fontSize: 13,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 36),
              const Center(child: _Fingerprint()),
              const SizedBox(height: 36),
              Text(
                'Unlock with your fingerprint',
                textAlign: TextAlign.center,
                style: t.headlineMedium,
              ),
              const SizedBox(height: 10),
              Text(
                'Your keys stay in this phone’s secure hardware. Only your fingerprint or face can open them.',
                textAlign: TextAlign.center,
                style: t.bodyLarge?.copyWith(color: context.zv.muted),
              ),
              if (support == QuickUnlockSupport.notEnrolled) ...[
                const SizedBox(height: 16),
                const ErrorBanner(
                  'Add a fingerprint in your phone’s settings first, then come back.',
                ),
              ],
              if (support == QuickUnlockSupport.unsupported) ...[
                const SizedBox(height: 16),
                const ErrorBanner(
                  'This phone has no fingerprint or face unlock. You’ll scan the QR code each time you open Zvault.',
                ),
              ],
              if (_error != null) ...[const SizedBox(height: 16), ErrorBanner(_error!)],
              const Spacer(flex: 3),
              FilledButton.icon(
                key: const Key('quick-unlock-on'),
                onPressed: support == QuickUnlockSupport.available && !_busy ? _turnOn : null,
                icon: const Icon(Icons.fingerprint_rounded),
                label: const Text('Turn on'),
              ),
              const SizedBox(height: 8),
              TextButton(
                key: const Key('quick-unlock-skip'),
                onPressed: _busy ? null : app.skipQuickUnlock,
                child: const Text('Not now'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Fingerprint extends StatefulWidget {
  const _Fingerprint();

  @override
  State<_Fingerprint> createState() => _FingerprintState();
}

class _FingerprintState extends State<_Fingerprint> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 2400),
  )..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.zv;
    return AnimatedBuilder(
      animation: _c,
      builder: (context, child) {
        final v = Curves.easeOut.transform(_c.value);
        return Container(
          width: 112,
          height: 112,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: c.okSoft,
            border: Border.all(color: c.ok.withValues(alpha: 0.6), width: 1.5),
            boxShadow: [
              BoxShadow(
                color: c.ok.withValues(alpha: 0.28 * (1 - v)),
                spreadRadius: 22 * v,
              ),
            ],
          ),
          child: child,
        );
      },
      child: Icon(Icons.fingerprint_rounded, size: 60, color: c.ok),
    );
  }
}
