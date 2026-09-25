import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app_state.dart';
import '../core.dart';
import '../theme.dart';
import '../widgets.dart';

class ItemDetailScreen extends StatefulWidget {
  const ItemDetailScreen({super.key, required this.item, this.revealed = false});

  final VaultItem item;

  /// Starts with the password shown. For screenshots and tests.
  final bool revealed;

  @override
  State<ItemDetailScreen> createState() => _ItemDetailScreenState();
}

class _ItemDetailScreenState extends State<ItemDetailScreen> {
  ItemDetail? _detail;
  OneTimeCode? _code;
  String? _error;
  late bool _reveal = widget.revealed;
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    final app = context.read<AppState>();
    try {
      final d = await app.openItem(widget.item);
      if (!mounted) return;
      setState(() => _detail = d);
      if (d.hasTotp) {
        await _refreshCode();
        _tick = Timer.periodic(const Duration(seconds: 1), (_) => _refreshCode());
      }
    } catch (_) {
      if (mounted) setState(() => _error = "Couldn't open this item.");
    }
  }

  Future<void> _refreshCode() async {
    final c = await context.read<AppState>().itemCode(widget.item);
    if (mounted) setState(() => _code = c);
  }

  Future<void> _copy(String label, String value) async {
    await SecureClipboard.copy(value);
    if (mounted) showToast(context, '$label copied. Clears in a minute.');
  }

  @override
  Widget build(BuildContext context) {
    final d = _detail;
    final title = d?.title ?? widget.item.summary.title;
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.item.vaultName, style: const TextStyle(fontSize: 16, color: Zv.text2)),
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 32),
          children: [
            Row(
              children: [
                LetterTile(title, size: 52),
                const SizedBox(width: 16),
                Expanded(child: Text(title, style: Theme.of(context).textTheme.headlineMedium)),
              ],
            ),
            const SizedBox(height: 24),
            if (_error != null) ErrorBanner(_error!),
            if (d == null && _error == null) const Center(child: CircularProgressIndicator()),
            if (d != null) ...[
              Panel(
                child: Column(
                  children: [
                    if (d.username.isNotEmpty)
                      _Field(
                        label: 'Username',
                        child: Text(d.username, style: const TextStyle(fontSize: 16)),
                        onCopy: () => _copy('Username', d.username),
                      ),
                    if (d.username.isNotEmpty && d.password.isNotEmpty) const Divider(),
                    if (d.password.isNotEmpty)
                      _Field(
                        label: 'Password',
                        trailing: IconButton(
                          key: const Key('reveal-password'),
                          tooltip: _reveal ? 'Hide' : 'Show',
                          onPressed: () => setState(() => _reveal = !_reveal),
                          icon: Icon(
                            _reveal ? Icons.visibility_off_outlined : Icons.visibility_outlined,
                            color: Zv.text2,
                          ),
                        ),
                        onCopy: () => _copy('Password', d.password),
                        child: SecretText(d.password, masked: !_reveal),
                      ),
                    if (_code != null) ...[
                      const Divider(),
                      _Field(
                        label: 'One-time code',
                        child: _Totp(_code!),
                        onCopy: () => _copy('Code', _code!.code),
                      ),
                    ],
                  ],
                ),
              ),
              if (d.urls.isNotEmpty) ...[
                const SizedBox(height: 24),
                const SectionLabel('Websites'),
                Panel(
                  child: Column(
                    children: [
                      for (final (i, url) in d.urls.indexed) ...[
                        if (i > 0) const Divider(),
                        _Field(
                          label: i == 0 ? 'Website' : 'Website ${i + 1}',
                          child: Text(
                            url,
                            style: const TextStyle(fontSize: 15, color: Zv.irisText),
                          ),
                          onCopy: () => _copy('Website', url),
                        ),
                      ],
                    ],
                  ),
                ),
              ],
              if (d.notes.isNotEmpty) ...[
                const SizedBox(height: 24),
                const SectionLabel('Notes'),
                Panel(
                  padding: const EdgeInsets.all(16),
                  child: SizedBox(
                    width: double.infinity,
                    child: SelectableText(
                      d.notes,
                      style: const TextStyle(fontSize: 15, height: 1.5),
                    ),
                  ),
                ),
              ],
            ],
          ],
        ),
      ),
    );
  }
}

class _Field extends StatelessWidget {
  const _Field({required this.label, required this.child, required this.onCopy, this.trailing});

  final String label;
  final Widget child;
  final VoidCallback onCopy;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onCopy,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 6, 12),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(label, style: const TextStyle(fontSize: 12, color: Zv.muted)),
                  const SizedBox(height: 4),
                  child,
                ],
              ),
            ),
            ?trailing,
            IconButton(
              tooltip: 'Copy $label',
              onPressed: onCopy,
              icon: const Icon(Icons.copy_rounded, size: 20, color: Zv.text2),
            ),
          ],
        ),
      ),
    );
  }
}

class _Totp extends StatelessWidget {
  const _Totp(this.code);

  final OneTimeCode code;

  @override
  Widget build(BuildContext context) {
    final c = code.code;
    final grouped = c.length == 6 ? '${c.substring(0, 3)} ${c.substring(3)}' : c;
    final low = code.remaining <= 5;
    return Row(
      children: [
        Text(
          grouped,
          style: Zv.monoStyle.copyWith(fontSize: 24, color: Zv.irisText, letterSpacing: 2),
        ),
        const SizedBox(width: 14),
        SizedBox(
          width: 22,
          height: 22,
          child: CircularProgressIndicator(
            value: code.remaining / code.period,
            strokeWidth: 3,
            color: low ? Zv.attn : Zv.irisText,
            backgroundColor: Zv.line,
          ),
        ),
        const SizedBox(width: 8),
        Text('${code.remaining}s', style: TextStyle(color: low ? Zv.attn : Zv.muted, fontSize: 13)),
      ],
    );
  }
}
