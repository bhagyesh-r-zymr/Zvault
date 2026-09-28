import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app_state.dart';
import '../core.dart';
import '../theme.dart';
import '../widgets.dart';
import 'home.dart';

/// Items and secrets other Zvault users shared with this account, as the
/// Mac's Sharing screen lists them. Each is decrypted here when opened.
class SharedWithMeScreen extends StatefulWidget {
  const SharedWithMeScreen({super.key});

  @override
  State<SharedWithMeScreen> createState() => _SharedWithMeScreenState();
}

class _SharedWithMeScreenState extends State<SharedWithMeScreen> {
  List<IncomingShare>? _shares;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final shares = await context.read<AppState>().incomingShares();
      if (mounted) {
        setState(() {
          _shares = shares;
          _error = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  Future<void> _remove(IncomingShare share) async {
    try {
      await context.read<AppState>().removeIncomingShare(share);
      await _load();
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    final shares = _shares;
    return Scaffold(
      appBar: AppBar(title: const Text('Shared with you')),
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: _load,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 32),
            children: [
              if (_error != null) ...[ErrorBanner(_error!), const SizedBox(height: 12)],
              if (shares == null && _error == null)
                const Padding(
                  padding: EdgeInsets.only(top: 48),
                  child: Center(child: CircularProgressIndicator()),
                ),
              if (shares != null && shares.isEmpty)
                const EmptyState(
                  icon: Icons.inbox_outlined,
                  title: 'Nothing shared with you yet',
                  body: 'When someone shares an item with your Zvault email, it shows up here.',
                ),
              for (final share in shares ?? const <IncomingShare>[]) ...[
                _ShareCard(key: ValueKey(share.id), share: share, onRemove: () => _remove(share)),
                const SizedBox(height: 12),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _ShareCard extends StatefulWidget {
  const _ShareCard({super.key, required this.share, required this.onRemove});

  final IncomingShare share;
  final VoidCallback onRemove;

  @override
  State<_ShareCard> createState() => _ShareCardState();
}

class _ShareCardState extends State<_ShareCard> {
  SharedItem? _item;
  OneTimeCode? _code;
  String? _fingerprint;
  late PinCheck _pin = context.read<AppState>().senderPin(widget.share);
  bool _reveal = false;
  String? _error;
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    context.read<AppState>().senderFingerprint(widget.share).then((f) {
      if (mounted) setState(() => _fingerprint = f);
    }, onError: (_) {});
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  Future<void> _open() async {
    final app = context.read<AppState>();
    try {
      final item = await app.openShare(widget.share);
      if (!mounted) return;
      setState(() {
        _item = item;
        _pin = PinCheck.match;
        _error = null;
      });
      if (item.totp.isNotEmpty) {
        await _refreshCode(item.totp);
        _tick = Timer.periodic(const Duration(seconds: 1), (_) => _refreshCode(item.totp));
      }
    } catch (_) {
      if (mounted) {
        setState(
          () => _error = "Couldn't decrypt. It may have been sent to an older key of yours.",
        );
      }
    }
  }

  Future<void> _refreshCode(String totp) async {
    try {
      final code = await context.read<AppState>().sharedCode(totp);
      if (mounted) setState(() => _code = code);
    } catch (_) {
      if (mounted) setState(() => _error = "This item's 2FA setup couldn't be read.");
    }
  }

  Future<void> _copy(String label, String value) async {
    await SecureClipboard.copy(value);
    if (mounted) showToast(context, '$label copied. Clears in a minute.');
  }

  @override
  Widget build(BuildContext context) {
    final c = context.zv;
    final s = widget.share;
    final item = _item;
    final when = s.createdAt.toLocal();
    final date = '${when.day}/${when.month}/${when.year}';
    return Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 12, 8, 12),
            child: Row(
              children: [
                item == null
                    ? CircleAvatar(
                        radius: 20,
                        backgroundColor: c.accentSoft,
                        child: Text(
                          s.senderEmail[0].toUpperCase(),
                          style: TextStyle(color: c.accent, fontWeight: FontWeight.w800),
                        ),
                      )
                    : LetterTile(item.title, size: 40, radius: 11),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        item?.title ?? 'From ${s.senderEmail}',
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: c.ink),
                      ),
                      Text(
                        item == null ? date : 'From ${s.senderEmail} · $date',
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 12.5, color: c.muted),
                      ),
                    ],
                  ),
                ),
                if (item == null)
                  FilledButton(
                    key: Key('open-share-${s.id}'),
                    style: FilledButton.styleFrom(
                      minimumSize: const Size(0, 38),
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                    ),
                    onPressed: _open,
                    child: Text(_pin == PinCheck.changed ? 'Open anyway' : 'Open'),
                  ),
                PopupMenuButton<String>(
                  tooltip: 'More',
                  onSelected: (_) => widget.onRemove(),
                  itemBuilder: (_) => const [PopupMenuItem(value: 'remove', child: Text('Remove'))],
                ),
              ],
            ),
          ),
          if (item == null && _fingerprint != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 0, 14, 12),
              child: Text(
                'Security code $_fingerprint',
                style: Zv.monoStyle.copyWith(fontSize: 12, color: c.muted),
              ),
            ),
          if (_pin == PinCheck.changed && item == null)
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 0, 14, 12),
              child: Notice(
                icon: Icons.warning_amber_rounded,
                tone: ZvTone.danger,
                text:
                    "${s.senderEmail}'s security code has changed since you last received from them. Someone may be pretending to be them. Check the code with them before opening.",
              ),
            ),
          if (_error != null)
            Padding(padding: const EdgeInsets.fromLTRB(14, 0, 14, 12), child: ErrorBanner(_error!)),
          if (item != null) ..._fields(context, item),
        ],
      ),
    );
  }

  List<Widget> _fields(BuildContext context, SharedItem item) {
    final c = context.zv;
    final value = TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: c.ink);
    final rows = <Widget>[
      if (item.secretKey != null)
        _Row(
          label: 'project secret · ${item.secretFrom}',
          onCopy: () => _copy('Key', item.secretKey!),
          child: Text(item.secretKey!, style: Zv.monoStyle.copyWith(color: c.ink)),
        ),
      if (item.username.isNotEmpty)
        _Row(
          label: 'username',
          onCopy: () => _copy('Username', item.username),
          child: Text(item.username, style: value),
        ),
      if (item.password.isNotEmpty)
        _Row(
          label: item.secretKey != null ? 'value' : 'password',
          onCopy: () => _copy(item.secretKey != null ? 'Value' : 'Password', item.password),
          trailing: IconButton(
            tooltip: _reveal ? 'Hide' : 'Show',
            onPressed: () => setState(() => _reveal = !_reveal),
            icon: Icon(
              _reveal ? Icons.visibility_off_outlined : Icons.visibility_outlined,
              size: 20,
            ),
          ),
          child: SecretText(item.password, masked: !_reveal, size: 15),
        ),
      if (_code != null)
        _Row(
          key: const Key('shared-totp'),
          label: 'one-time password',
          onCopy: () => _copy('Code', _code!.code),
          child: OneTimeCodeView(_code!),
        ),
      if (item.url.isNotEmpty)
        _Row(
          label: 'website',
          onCopy: () => _copy('Website', item.url),
          child: Text(item.url, style: value.copyWith(color: c.accent)),
        ),
      if (item.passkeySite != null)
        _Row(
          label: 'passkey',
          onCopy: () => _copy('Website', item.passkeySite!),
          child: Text('For ${item.passkeySite}', style: value),
        ),
      if (item.notes.isNotEmpty)
        _Row(
          label: 'notes',
          onCopy: () => _copy('Notes', item.notes),
          child: Text(item.notes, style: TextStyle(fontSize: 15, color: c.ink, height: 1.45)),
        ),
    ];
    return [
      for (final row in rows) ...[const Divider(), row],
    ];
  }
}

class _Row extends StatelessWidget {
  const _Row({
    super.key,
    required this.label,
    required this.child,
    required this.onCopy,
    this.trailing,
  });

  final String label;
  final Widget child;
  final VoidCallback onCopy;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
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
                  Text(label, style: TextStyle(fontSize: 12, color: context.zv.muted)),
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
