import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:share_plus/share_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../app_state.dart';
import '../theme.dart';
import '../widgets.dart';

const _day = 24 * 60 * 60;
const _expiryOptions = [
  ('1 hour', 60 * 60),
  ('1 day', _day),
  ('7 days', 7 * _day),
  ('30 days', 30 * _day),
];

String _message(Object e) => e is FormatException ? e.message : e.toString();

enum _Mode { link, person }

/// Share one item by secure link or with another Zvault user, as on the Mac.
/// The item is encrypted on this phone; the link's key never reaches Zvault.
class ShareItemScreen extends StatefulWidget {
  const ShareItemScreen({super.key, required this.item, required this.title});

  final VaultItem item;
  final String title;

  @override
  State<ShareItemScreen> createState() => _ShareItemScreenState();
}

class _ShareItemScreenState extends State<ShareItemScreen> {
  _Mode _mode = _Mode.link;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Share')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 32),
          children: [
            Row(
              children: [
                LetterTile(widget.title, size: 44),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(widget.title, style: Theme.of(context).textTheme.titleLarge),
                      const SizedBox(height: 2),
                      const Text(
                        'Encrypted on this phone before it leaves',
                        style: TextStyle(fontSize: 13, color: Zv.muted),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 20),
            SegmentedButton<_Mode>(
              showSelectedIcon: false,
              segments: const [
                ButtonSegment(
                  value: _Mode.link,
                  label: Text('Secure link'),
                  icon: Icon(Icons.link_rounded),
                ),
                ButtonSegment(
                  value: _Mode.person,
                  label: Text('Zvault user'),
                  icon: Icon(Icons.person_outline_rounded),
                ),
              ],
              selected: {_mode},
              onSelectionChanged: (s) => setState(() => _mode = s.first),
            ),
            const SizedBox(height: 24),
            if (_mode == _Mode.link)
              _ShareByLink(item: widget.item, title: widget.title)
            else
              _ShareWithPerson(item: widget.item),
          ],
        ),
      ),
    );
  }
}

class _ShareByLink extends StatefulWidget {
  const _ShareByLink({required this.item, required this.title});

  final VaultItem item;
  final String title;

  @override
  State<_ShareByLink> createState() => _ShareByLinkState();
}

class _ShareByLinkState extends State<_ShareByLink> {
  int _expiresInSeconds = 7 * _day;
  int _maxViews = 1;
  bool _onlyEmails = false;
  final _emails = TextEditingController();
  CreatedShareLink? _link;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _emails.dispose();
    super.dispose();
  }

  Future<void> _create() async {
    setState(() => _error = null);
    List<String>? allowed;
    if (_onlyEmails) {
      try {
        allowed = parseShareEmails(_emails.text);
      } on FormatException catch (e) {
        setState(() => _error = e.message);
        return;
      }
    }
    setState(() => _busy = true);
    try {
      final link = await context.read<AppState>().createShareLink(
        widget.item,
        expiresInSeconds: _expiresInSeconds,
        maxViews: _maxViews,
        allowedEmails: allowed,
      );
      if (mounted) setState(() => _link = link);
    } catch (e) {
      if (mounted) setState(() => _error = _message(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String get _subject => 'I shared "${widget.title}" with you';

  String _body(CreatedShareLink link) => [
    'I shared "${widget.title}" with you using Zvault.',
    '',
    'Open this link: ${link.url}',
    '',
    if (link.allowedEmails != null)
      'Enter your email address on the page and Zvault will email you a one-time code. You do not need a Zvault account.'
    else
      'The link stops working after ${link.maxViews} ${link.maxViews == 1 ? 'view' : 'views'}.',
  ].join('\n');

  /// Android's share sheet: Slack, WhatsApp, Teams, Gmail and the rest.
  Future<void> _shareSheet(CreatedShareLink link) async {
    await SharePlus.instance.share(ShareParams(text: _body(link), subject: _subject));
  }

  /// A new message in the person's own mail app, addressed to the allowed
  /// emails. The link goes from their mailbox, never through Zvault.
  Future<void> _email(CreatedShareLink link) async {
    final to = link.allowedEmails!.map(Uri.encodeComponent).join(',');
    final uri = Uri.parse(
      'mailto:$to?subject=${Uri.encodeComponent(_subject)}&body=${Uri.encodeComponent(_body(link))}',
    );
    if (!await launchUrl(uri) && mounted) {
      setState(() => _error = 'No mail app found. Use Share link instead.');
    }
  }

  Future<void> _copy(String url) async {
    await SecureClipboard.copy(url);
    if (mounted) showToast(context, 'Link copied. Clears in a minute.');
  }

  @override
  Widget build(BuildContext context) {
    final link = _link;
    return link == null ? _form(context) : _created(context, link);
  }

  Widget _created(BuildContext context, CreatedShareLink link) {
    final allowed = link.allowedEmails;
    final unverified = link.unverifiedEmails;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          allowed != null
              ? 'Only ${allowed.join(', ')} can open this link, after confirming their email with a one-time code. It is shown only now.'
              : 'Anyone with this link can view the item. It is shown only now.',
          style: Theme.of(context).textTheme.bodyMedium,
        ),
        const SizedBox(height: 14),
        Panel(
          padding: const EdgeInsets.all(14),
          child: SelectableText(
            link.url,
            key: const Key('share-link-url'),
            style: Zv.monoStyle.copyWith(fontSize: 13, color: Zv.irisText),
          ),
        ),
        const SizedBox(height: 14),
        _Notice(
          icon: Icons.shield_outlined,
          color: Zv.secure,
          background: Zv.secureBg,
          border: Zv.secureLine,
          text:
              'The key is in the part after #, which browsers never send to our servers. It stops working after ${link.maxViews} ${link.maxViews == 1 ? 'view' : 'views'} or when it expires.',
        ),
        if (unverified.isNotEmpty) ...[
          const SizedBox(height: 10),
          _Notice(
            icon: Icons.warning_amber_rounded,
            color: Zv.attn,
            background: Zv.attnBg,
            border: Zv.attnLine,
            text:
                'Zvault email is in test mode, so only verified addresses get the code. ${unverified.join(', ')} ${unverified.length == 1 ? 'is' : 'are'} not verified yet and may not receive it. Ask the Zvault owner to verify ${unverified.length == 1 ? 'that address' : 'those addresses'} first.',
          ),
        ],
        if (_error != null) ...[const SizedBox(height: 12), ErrorBanner(_error!)],
        const SizedBox(height: 20),
        FilledButton.icon(
          key: const Key('share-link-send'),
          onPressed: () => _shareSheet(link),
          icon: const Icon(Icons.share_rounded, size: 20),
          label: const Text('Share link'),
        ),
        if (allowed != null) ...[
          const SizedBox(height: 10),
          OutlinedButton.icon(
            onPressed: () => _email(link),
            icon: const Icon(Icons.mail_outline_rounded, size: 20),
            label: const Text('Email the link'),
          ),
        ],
        const SizedBox(height: 10),
        OutlinedButton.icon(
          onPressed: () => _copy(link.url),
          icon: const Icon(Icons.copy_rounded, size: 20),
          label: const Text('Copy link'),
        ),
        const SizedBox(height: 6),
        TextButton(
          onPressed: () => setState(() => _link = null),
          child: const Text('Make another link'),
        ),
      ],
    );
  }

  Widget _form(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SectionLabel('Link expires after'),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final (label, seconds) in _expiryOptions)
              ChoiceChip(
                label: Text(label),
                selected: _expiresInSeconds == seconds,
                showCheckmark: false,
                onSelected: (_) => setState(() => _expiresInSeconds = seconds),
              ),
          ],
        ),
        const SizedBox(height: 20),
        const SectionLabel('Views allowed'),
        Panel(
          child: Row(
            children: [
              IconButton(
                tooltip: 'Fewer views',
                onPressed: _maxViews > 1 ? () => setState(() => _maxViews--) : null,
                icon: const Icon(Icons.remove_rounded),
              ),
              Expanded(
                child: Text(
                  '$_maxViews ${_maxViews == 1 ? 'view' : 'views'}',
                  key: const Key('share-views'),
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w500),
                ),
              ),
              IconButton(
                tooltip: 'More views',
                onPressed: _maxViews < ShareLimits.maxViews
                    ? () => setState(() => _maxViews++)
                    : null,
                icon: const Icon(Icons.add_rounded),
              ),
            ],
          ),
        ),
        const SizedBox(height: 20),
        const SectionLabel('Who can open it'),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            ChoiceChip(
              label: const Text('Anyone with the link'),
              selected: !_onlyEmails,
              showCheckmark: false,
              onSelected: (_) => setState(() => _onlyEmails = false),
            ),
            ChoiceChip(
              key: const Key('share-only-emails'),
              label: const Text('Only these emails'),
              selected: _onlyEmails,
              showCheckmark: false,
              onSelected: (_) => setState(() => _onlyEmails = true),
            ),
          ],
        ),
        if (_onlyEmails) ...[
          const SizedBox(height: 14),
          TextField(
            key: const Key('share-emails'),
            controller: _emails,
            keyboardType: TextInputType.emailAddress,
            autocorrect: false,
            minLines: 1,
            maxLines: 3,
            decoration: const InputDecoration(hintText: 'name@company.com, other@company.com'),
          ),
          const SizedBox(height: 8),
          const Text(
            'They open the link, enter their email and type the one-time code Zvault emails them. No Zvault account needed.',
            style: TextStyle(fontSize: 13, color: Zv.muted, height: 1.4),
          ),
        ],
        if (_error != null) ...[const SizedBox(height: 16), ErrorBanner(_error!)],
        const SizedBox(height: 24),
        FilledButton.icon(
          key: const Key('share-create-link'),
          onPressed: _busy ? null : _create,
          icon: const Icon(Icons.link_rounded, size: 20),
          label: Text(_busy ? 'Encrypting…' : 'Create secure link'),
        ),
      ],
    );
  }
}

class _ShareWithPerson extends StatefulWidget {
  const _ShareWithPerson({required this.item});

  final VaultItem item;

  @override
  State<_ShareWithPerson> createState() => _ShareWithPersonState();
}

class _ShareWithPersonState extends State<_ShareWithPerson> {
  final _email = TextEditingController();
  ShareRecipient? _recipient;
  String? _sentTo;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    super.dispose();
  }

  Future<void> _run(Future<void> Function(AppState app) step) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await step(context.read<AppState>());
    } catch (e) {
      if (mounted) setState(() => _error = _message(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _find() => _run((app) async {
    final r = await app.findShareRecipient(_email.text);
    if (mounted) setState(() => _recipient = r);
  });

  Future<void> _send(ShareRecipient r) => _run((app) async {
    await app.shareWithUser(widget.item, r);
    if (mounted) {
      setState(() {
        _sentTo = r.email;
        _recipient = null;
        _email.clear();
      });
    }
  });

  @override
  Widget build(BuildContext context) {
    final sentTo = _sentTo;
    if (sentTo != null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _Notice(
            icon: Icons.verified_user_outlined,
            color: Zv.secure,
            background: Zv.secureBg,
            border: Zv.secureLine,
            text: 'Shared with $sentTo. They will get an email and see it in Zvault.',
          ),
          const SizedBox(height: 16),
          OutlinedButton(
            onPressed: () => setState(() => _sentTo = null),
            child: const Text('Share with someone else'),
          ),
        ],
      );
    }
    final r = _recipient;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SectionLabel('Their Zvault email'),
        TextField(
          key: const Key('share-person-email'),
          controller: _email,
          keyboardType: TextInputType.emailAddress,
          autocorrect: false,
          onChanged: (_) => setState(() => _recipient = null),
          decoration: const InputDecoration(hintText: 'name@company.com'),
        ),
        const SizedBox(height: 16),
        if (r == null)
          FilledButton(
            onPressed: _busy || !_email.text.contains('@') ? null : _find,
            child: const Text('Find'),
          )
        else ...[
          Panel(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Security code for ${r.email}',
                  style: const TextStyle(fontSize: 12, color: Zv.muted),
                ),
                const SizedBox(height: 6),
                SelectableText(r.fingerprint, style: Zv.monoStyle.copyWith(fontSize: 14)),
              ],
            ),
          ),
          if (r.pin == PinCheck.changed) ...[
            const SizedBox(height: 10),
            _Notice(
              icon: Icons.warning_amber_rounded,
              color: Zv.danger,
              background: Zv.dangerBg,
              border: Zv.dangerLine,
              text:
                  'This security code is different from the one ${r.email} had before. Someone may be pretending to be them. Check the code with them before sending.',
            ),
          ],
          const SizedBox(height: 10),
          const Text(
            'For sensitive items, ask them to read out the code in their Zvault settings. If it differs, do not send.',
            style: TextStyle(fontSize: 13, color: Zv.muted, height: 1.4),
          ),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: _busy ? null : () => _send(r),
            child: Text('Share with ${r.email}', overflow: TextOverflow.ellipsis),
          ),
        ],
        if (_error != null) ...[const SizedBox(height: 16), ErrorBanner(_error!)],
      ],
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({
    required this.icon,
    required this.color,
    required this.background,
    required this.border,
    required this.text,
  });

  final IconData icon;
  final Color color;
  final Color background;
  final Color border;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(Zv.radiusM),
        border: Border.all(color: border),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 18, color: color),
          const SizedBox(width: 10),
          Expanded(
            child: Text(text, style: TextStyle(fontSize: 13.5, color: color, height: 1.4)),
          ),
        ],
      ),
    );
  }
}
