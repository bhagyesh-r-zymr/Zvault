import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app_state.dart';
import '../theme.dart';
import '../widgets.dart';

/// Claims the scanned QR code, shows the six-digit code to compare with the
/// Mac, and waits for the person to tap Allow there.
class PairingScreen extends StatefulWidget {
  const PairingScreen({super.key, required this.uri});

  final String uri;

  @override
  State<PairingScreen> createState() => _PairingScreenState();
}

class _PairingScreenState extends State<PairingScreen> {
  PendingPairing? _pending;
  String? _error;
  Timer? _poll;
  bool _finishing = false;

  @override
  void initState() {
    super.initState();
    _begin();
  }

  @override
  void dispose() {
    _poll?.cancel();
    if (!_finishing) context.read<AppState>().cancelPairing();
    super.dispose();
  }

  Future<void> _begin() async {
    final app = context.read<AppState>();
    try {
      final pending = await app.beginPairing(widget.uri);
      if (!mounted) return;
      setState(() => _pending = pending);
      _poll = Timer.periodic(const Duration(milliseconds: 1500), (_) => _check());
    } catch (e) {
      if (mounted) setState(() => _error = _describe(e));
    }
  }

  bool _checking = false;

  Future<void> _check() async {
    final pending = _pending;
    if (pending == null || _checking) return;
    _checking = true;
    try {
      _finishing = true;
      final done = await context.read<AppState>().pollPairing(pending);
      if (!done) {
        _finishing = false;
        return;
      }
      _poll?.cancel();
      // The app switches to the unlocked shell; close this flow.
      if (mounted) Navigator.of(context).popUntil((r) => r.isFirst);
    } catch (e) {
      _finishing = false;
      _poll?.cancel();
      if (mounted) setState(() => _error = _describe(e));
    } finally {
      _checking = false;
    }
  }

  static String _describe(Object e) {
    final s = e.toString();
    return s.startsWith('AnyhowException(') ? s.substring(16, s.length - 1).split('\n').first : s;
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final pending = _pending;
    return Scaffold(
      appBar: AppBar(title: const Text('Sign in')),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 8, 24, 20),
          child: _error != null
              ? _Failed(message: _error!)
              : pending == null
              ? const Center(child: CircularProgressIndicator())
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const SizedBox(height: 12),
                    const _Link(),
                    const SizedBox(height: 32),
                    Text('Check the code', style: t.headlineMedium),
                    const SizedBox(height: 8),
                    Text(
                      'Your Mac shows a code too. If they match, tap Allow on your Mac.',
                      style: t.bodyLarge?.copyWith(color: context.zv.muted),
                    ),
                    const SizedBox(height: 24),
                    _Code(pending.scanned.code),
                    const Spacer(),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                        const SizedBox(width: 12),
                        Text('Waiting for your Mac…', style: TextStyle(color: context.zv.muted)),
                      ],
                    ),
                    const SizedBox(height: 20),
                    Text(
                      "Don't recognise this? Tap Deny on your Mac.",
                      textAlign: TextAlign.center,
                      style: TextStyle(color: context.zv.muted, fontSize: 13),
                    ),
                  ],
                ),
        ),
      ),
    );
  }
}

class _Code extends StatelessWidget {
  const _Code(this.code);

  final String code;

  @override
  Widget build(BuildContext context) {
    final grouped = code.length == 6 ? '${code.substring(0, 3)} ${code.substring(3)}' : code;
    return Container(
      key: const Key('pair-code'),
      padding: const EdgeInsets.symmetric(vertical: 22),
      decoration: BoxDecoration(
        color: context.zv.attentionSoft,
        borderRadius: BorderRadius.circular(Zv.radiusL),
      ),
      child: Text(
        grouped,
        textAlign: TextAlign.center,
        semanticsLabel: 'Code ${code.split('').join(' ')}',
        style: Zv.monoStyle.copyWith(
          fontSize: 44,
          color: context.zv.attention,
          letterSpacing: 6,
          fontWeight: FontWeight.w500,
        ),
      ),
    );
  }
}

/// Mac and phone joined by an animated line: the handshake in progress.
class _Link extends StatefulWidget {
  const _Link();

  @override
  State<_Link> createState() => _LinkState();
}

class _LinkState extends State<_Link> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1400),
  )..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.zv;
    Widget node(IconData icon, String label, {bool me = false}) => Column(
      children: [
        Container(
          width: 56,
          height: 56,
          decoration: BoxDecoration(
            color: me ? c.accentSoft : c.well,
            borderRadius: BorderRadius.circular(Zv.radiusL),
            border: Border.all(color: me ? c.accentSoft : c.line),
          ),
          child: Icon(icon, color: me ? c.accent : c.muted),
        ),
        const SizedBox(height: 8),
        Text(label, style: TextStyle(fontSize: 12, color: c.muted)),
      ],
    );
    return Row(
      children: [
        node(Icons.laptop_mac_rounded, 'Your Mac'),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.only(bottom: 20),
            child: AnimatedBuilder(
              animation: _c,
              builder: (context, _) =>
                  CustomPaint(size: const Size.fromHeight(12), painter: _Dots(_c.value, c)),
            ),
          ),
        ),
        node(Icons.smartphone_rounded, 'This phone', me: true),
      ],
    );
  }
}

class _Dots extends CustomPainter {
  _Dots(this.t, this.colors);

  final double t;
  final ZvColors colors;

  @override
  void paint(Canvas canvas, Size size) {
    const n = 9;
    final gap = size.width / (n + 1);
    for (var i = 1; i <= n; i++) {
      final phase = ((i / n) - t).abs();
      final glow = (1 - (phase * 3).clamp(0, 1)).toDouble();
      canvas.drawCircle(
        Offset(gap * i, size.height / 2),
        2 + glow * 1.5,
        Paint()..color = Color.lerp(colors.line, colors.accent, glow)!,
      );
    }
  }

  @override
  bool shouldRepaint(covariant _Dots old) => old.t != t;
}

class _Failed extends StatelessWidget {
  const _Failed({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 24),
        ErrorBanner(message),
        const Spacer(),
        FilledButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Scan again')),
      ],
    );
  }
}
