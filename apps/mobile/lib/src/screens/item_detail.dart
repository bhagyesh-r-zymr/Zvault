import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app_state.dart';
import '../core.dart';
import '../theme.dart';
import '../widgets.dart';
import 'share_item.dart';

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

  void _share(String title) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ShareItemScreen(item: widget.item, title: title),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = context.zv;
    final d = _detail;
    final title = d?.title ?? widget.item.summary.title;
    final subtitle = d == null
        ? widget.item.vaultName
        : d.urls.isNotEmpty
        ? _host(d.urls.first)
        : widget.item.vaultName;
    return Scaffold(
      appBar: AppBar(
        title: Text(
          widget.item.vaultName,
          style: TextStyle(fontSize: 15, fontWeight: FontWeight.w500, color: c.muted),
        ),
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 32),
          children: [
            Center(child: LetterTile(title, size: 58, radius: 16)),
            const SizedBox(height: 10),
            Text(
              title,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.headlineSmall,
            ),
            const SizedBox(height: 2),
            Text(
              subtitle,
              textAlign: TextAlign.center,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 13, color: c.muted),
            ),
            const SizedBox(height: 18),
            if (_error != null) ErrorBanner(_error!),
            if (d != null) ...[
              Row(
                children: [
                  if (d.password.isNotEmpty) ...[
                    Expanded(
                      child: FilledButton(
                        key: const Key('copy-password'),
                        onPressed: () => _copy('Password', d.password),
                        child: const Text('Copy password'),
                      ),
                    ),
                    const SizedBox(width: 10),
                  ],
                  Expanded(
                    child: OutlinedButton(
                      key: const Key('share-item'),
                      onPressed: () => _share(title),
                      child: const Text('Share'),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 16),
            ],
            if (d == null && _error == null) const Center(child: CircularProgressIndicator()),
            if (d != null) ...[
              if (d.username.isNotEmpty || d.password.isNotEmpty || _code != null)
                Panel(
                  child: Column(
                    children: [
                      if (d.username.isNotEmpty)
                        _Field(
                          label: 'username',
                          child: Text(
                            d.username,
                            style: TextStyle(
                              fontSize: 15,
                              fontWeight: FontWeight.w600,
                              color: c.ink,
                            ),
                          ),
                          onCopy: () => _copy('Username', d.username),
                        ),
                      if (d.username.isNotEmpty && d.password.isNotEmpty) const Divider(),
                      if (d.password.isNotEmpty)
                        _Field(
                          label: 'password',
                          trailing: IconButton(
                            key: const Key('reveal-password'),
                            tooltip: _reveal ? 'Hide' : 'Show',
                            onPressed: () => setState(() => _reveal = !_reveal),
                            icon: Icon(
                              _reveal ? Icons.visibility_off_outlined : Icons.visibility_outlined,
                              size: 20,
                            ),
                          ),
                          onCopy: () => _copy('Password', d.password),
                          child: SecretText(d.password, masked: !_reveal, size: 15),
                        ),
                      if (_code != null) ...[
                        if (d.username.isNotEmpty || d.password.isNotEmpty) const Divider(),
                        _Field(
                          label: 'one-time password',
                          child: _Totp(_code!),
                          onCopy: () => _copy('Code', _code!.code),
                        ),
                      ],
                    ],
                  ),
                ),
              if (d.urls.isNotEmpty) ...[
                const SizedBox(height: 12),
                Panel(
                  child: Column(
                    children: [
                      for (final (i, url) in d.urls.indexed) ...[
                        if (i > 0) const Divider(),
                        _Field(
                          label: i == 0 ? 'website' : 'website ${i + 1}',
                          child: Text(
                            url,
                            style: TextStyle(
                              fontSize: 15,
                              fontWeight: FontWeight.w600,
                              color: c.accent,
                            ),
                          ),
                          onCopy: () => _copy('Website', url),
                        ),
                      ],
                    ],
                  ),
                ),
              ],
              if (d.notes.isNotEmpty) ...[
                const SizedBox(height: 12),
                Panel(
                  padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
                  child: SizedBox(
                    width: double.infinity,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('notes', style: TextStyle(fontSize: 12, color: c.muted)),
                        const SizedBox(height: 3),
                        SelectableText(
                          d.notes,
                          style: TextStyle(fontSize: 15, height: 1.5, color: c.ink),
                        ),
                      ],
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

  static String _host(String url) {
    final u = Uri.tryParse(url.contains('://') ? url : 'https://$url');
    return u?.host.isNotEmpty == true ? u!.host : url;
  }
}

/// One field in a card: a small label above its value, tap to copy.
class _Field extends StatelessWidget {
  const _Field({required this.label, required this.child, required this.onCopy, this.trailing});

  final String label;
  final Widget child;
  final VoidCallback onCopy;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final c = context.zv;
    return InkWell(
      onTap: onCopy,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 10, 4, 10),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(label, style: TextStyle(fontSize: 12, color: c.muted)),
                  const SizedBox(height: 3),
                  child,
                ],
              ),
            ),
            ?trailing,
            IconButton(
              tooltip: 'Copy $label',
              onPressed: onCopy,
              icon: const Icon(Icons.copy_rounded, size: 19),
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
    final c = context.zv;
    final digits = code.code;
    final grouped = digits.length == 6
        ? '${digits.substring(0, 3)} ${digits.substring(3)}'
        : digits;
    final low = code.remaining <= 5;
    final ring = low ? c.attention : c.accent;
    return Row(
      children: [
        Text(
          grouped,
          style: Zv.monoStyle.copyWith(
            fontSize: 22,
            fontWeight: FontWeight.w600,
            color: c.ink,
            letterSpacing: 2,
          ),
        ),
        const Spacer(),
        Text(
          '${code.remaining}s',
          style: TextStyle(color: low ? c.attention : c.muted, fontSize: 12),
        ),
        const SizedBox(width: 8),
        SizedBox(
          width: 22,
          height: 22,
          child: CircularProgressIndicator(
            value: code.remaining / code.period,
            strokeWidth: 3,
            strokeCap: StrokeCap.round,
            color: ring,
            backgroundColor: c.line,
          ),
        ),
        const SizedBox(width: 4),
      ],
    );
  }
}
