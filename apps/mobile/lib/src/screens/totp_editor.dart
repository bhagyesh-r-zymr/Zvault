import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app_state.dart';
import '../core.dart';
import '../theme.dart';
import '../widgets.dart';
import 'scan.dart';

/// Adds, replaces or removes a login's 2FA setup, as the Mac's editor does:
/// scan the website's QR code or paste its setup key, check the first code,
/// save. The item is encrypted again on this phone before it is uploaded.
/// Pops with the saved item.
class TotpEditorScreen extends StatefulWidget {
  const TotpEditorScreen({super.key, required this.item, required this.hasTotp});

  final VaultItem item;

  /// Whether the item already has a setup (so it can be removed).
  final bool hasTotp;

  @override
  State<TotpEditorScreen> createState() => _TotpEditorScreenState();
}

class _TotpEditorScreenState extends State<TotpEditorScreen> {
  final _input = TextEditingController();
  TotpSetup? _setup;
  Timer? _tick;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _tick?.cancel();
    _input.dispose();
    super.dispose();
  }

  /// Checks what was scanned or typed and keeps the preview code current.
  Future<void> _check() async {
    _tick?.cancel();
    final text = _input.text.trim();
    if (text.isEmpty) {
      setState(() {
        _setup = null;
        _error = null;
      });
      return;
    }
    try {
      final setup = await context.read<AppState>().checkTotp(text);
      if (!mounted || _input.text.trim() != text) return;
      setState(() {
        _setup = setup;
        _error = null;
      });
      _tick = Timer.periodic(const Duration(seconds: 1), (_) => _refresh(text));
    } on FormatException catch (e) {
      if (mounted) {
        setState(() {
          _setup = null;
          _error = e.message;
        });
      }
    }
  }

  Future<void> _refresh(String text) async {
    try {
      final setup = await context.read<AppState>().checkTotp(text);
      if (mounted) setState(() => _setup = setup);
    } catch (_) {}
  }

  Future<void> _scan() async {
    final value = await Navigator.of(context)
        .push<String>(MaterialPageRoute(builder: (_) => const ScanScreen.totp()));
    if (value == null || !mounted) return;
    _input.text = value;
    await _check();
  }

  Future<void> _save(String totp) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final saved = await context.read<AppState>().setItemTotp(widget.item, totp);
      if (mounted) Navigator.of(context).pop(saved);
    } catch (e) {
      if (mounted) setState(() => _error = e is FormatException ? e.message : e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _confirmRemove() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Remove 2FA from this item?'),
        content: const Text(
          'Zvault stops showing codes for it. Keep another way to sign in, or you may be locked out of the website.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          TextButton(
            key: const Key('totp-remove-confirm'),
            onPressed: () => Navigator.of(context).pop(true),
            style: TextButton.styleFrom(foregroundColor: context.zv.danger),
            child: const Text('Remove'),
          ),
        ],
      ),
    );
    if (ok == true) await _save('');
  }

  @override
  Widget build(BuildContext context) {
    final c = context.zv;
    final setup = _setup;
    final who = setup == null
        ? ''
        : [setup.issuer, setup.account].where((s) => s.isNotEmpty).join(' · ');
    return Scaffold(
      appBar: AppBar(title: Text(widget.hasTotp ? 'Change 2FA' : 'Add 2FA')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 32),
          children: [
            Row(
              children: [
                LetterTile(widget.item.summary.title, size: 44, radius: 12),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        widget.item.summary.title,
                        style: Theme.of(context).textTheme.titleLarge,
                        overflow: TextOverflow.ellipsis,
                      ),
                      const SizedBox(height: 2),
                      Text(
                        'Encrypted on this phone before it leaves',
                        style: TextStyle(fontSize: 13, color: c.muted),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 20),
            Text(
              'Turn on two-factor authentication on the website, then scan the QR code it shows or paste its setup key.',
              style: TextStyle(fontSize: 14, color: c.ink, height: 1.45),
            ),
            const SizedBox(height: 16),
            FilledButton.icon(
              key: const Key('totp-scan'),
              onPressed: _busy ? null : _scan,
              icon: const Icon(Icons.qr_code_scanner_rounded, size: 20),
              label: const Text('Scan QR code'),
            ),
            const SizedBox(height: 18),
            const SectionLabel('Or paste the setup key'),
            TextField(
              key: const Key('totp-input'),
              controller: _input,
              autocorrect: false,
              enableSuggestions: false,
              minLines: 1,
              maxLines: 3,
              style: Zv.monoStyle.copyWith(fontSize: 14, color: c.ink),
              onChanged: (_) => _check(),
              decoration: const InputDecoration(hintText: 'JBSW Y3DP EHPK 3PXP or otpauth://…'),
            ),
            if (setup != null) ...[
              const SizedBox(height: 16),
              Panel(
                padding: const EdgeInsets.fromLTRB(14, 10, 10, 12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      who.isEmpty ? 'first code' : who,
                      style: TextStyle(fontSize: 12, color: c.muted),
                    ),
                    const SizedBox(height: 3),
                    OneTimeCodeView(setup.current),
                  ],
                ),
              ),
              const SizedBox(height: 8),
              Text(
                'If the website asks for a code to finish turning on 2FA, type this one.',
                style: TextStyle(fontSize: 13, color: c.muted, height: 1.4),
              ),
            ],
            if (_error != null) ...[const SizedBox(height: 16), ErrorBanner(_error!)],
            const SizedBox(height: 24),
            FilledButton(
              key: const Key('totp-save'),
              onPressed: _busy || setup == null ? null : () => _save(_input.text),
              child: Text(_busy ? 'Saving…' : 'Save'),
            ),
            if (widget.hasTotp) ...[
              const SizedBox(height: 8),
              TextButton(
                key: const Key('totp-remove'),
                onPressed: _busy ? null : _confirmRemove,
                style: TextButton.styleFrom(foregroundColor: c.danger),
                child: const Text('Remove 2FA'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
