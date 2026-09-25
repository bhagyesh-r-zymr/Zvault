import 'package:flutter/material.dart';

import '../theme.dart';
import '../widgets.dart';
import 'pairing.dart';
import 'scan.dart';

/// First launch: sign in by scanning the QR code on the Mac.
class WelcomeScreen extends StatelessWidget {
  const WelcomeScreen({super.key});

  Future<void> _scan(BuildContext context) async {
    final uri = await Navigator.of(
      context,
    ).push<String>(MaterialPageRoute(builder: (_) => const ScanScreen(), fullscreenDialog: true));
    if (uri != null && context.mounted) await _pair(context, uri);
  }

  Future<void> _paste(BuildContext context) async {
    final uri = await askForCode(context);
    if (uri != null && context.mounted) await _pair(context, uri);
  }

  Future<void> _pair(BuildContext context, String uri) =>
      Navigator.of(context).push(MaterialPageRoute(builder: (_) => PairingScreen(uri: uri)));

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 24, 24, 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Spacer(flex: 3),
              const Center(child: BrandMark(size: 64, halo: true)),
              const SizedBox(height: 28),
              Text('Zvault', textAlign: TextAlign.center, style: t.headlineMedium),
              const SizedBox(height: 10),
              Text(
                'Your passwords and project secrets,\nend-to-end encrypted.',
                textAlign: TextAlign.center,
                style: t.bodyLarge?.copyWith(color: context.zv.muted),
              ),
              const Spacer(flex: 2),
              const _MacHint(),
              const Spacer(flex: 2),
              FilledButton.icon(
                key: const Key('scan'),
                onPressed: () => _scan(context),
                icon: const Icon(Icons.qr_code_scanner_rounded),
                label: const Text('Sign in with QR code'),
              ),
              const SizedBox(height: 8),
              TextButton(
                key: const Key('paste'),
                onPressed: () => _paste(context),
                child: const Text('Paste a sign-in code instead'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Where to find the QR code, drawn as the Mac's own menu path.
class _MacHint extends StatelessWidget {
  const _MacHint();

  @override
  Widget build(BuildContext context) {
    final c = context.zv;
    Widget crumb(String s, {bool last = false}) => Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: last ? c.accentSoft : c.well,
        borderRadius: BorderRadius.circular(Zv.radiusS),
        border: Border.all(color: last ? c.accentSoft : c.line),
      ),
      child: Text(
        s,
        style: TextStyle(fontSize: 13, fontWeight: FontWeight.w500, color: last ? c.accent : c.ink),
      ),
    );
    final sep = Icon(Icons.chevron_right_rounded, size: 18, color: c.muted);
    return Panel(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.laptop_mac_rounded, size: 18, color: c.muted),
              const SizedBox(width: 8),
              Text('On your Mac, open', style: TextStyle(color: c.muted, fontSize: 14)),
            ],
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 4,
            runSpacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              crumb('Settings'),
              sep,
              crumb('Devices'),
              sep,
              crumb('Add phone', last: true),
            ],
          ),
        ],
      ),
    );
  }
}

/// A sheet to paste the code the Mac shows under "Can't scan?".
Future<String?> askForCode(BuildContext context) {
  final controller = TextEditingController();
  return showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(Zv.radiusXl)),
    ),
    builder: (context) => Padding(
      padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + MediaQuery.of(context).viewInsets.bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Paste a sign-in code', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 6),
          Text(
            'On your Mac, tap “Can’t scan? Show it as text” under the QR code and copy it.',
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 16),
          TextField(
            key: const Key('code-field'),
            controller: controller,
            autofocus: true,
            minLines: 2,
            maxLines: 4,
            style: Zv.monoStyle.copyWith(fontSize: 13, color: context.zv.ink),
            decoration: const InputDecoration(hintText: 'zvault://pair?…'),
          ),
          const SizedBox(height: 16),
          FilledButton(
            key: const Key('code-continue'),
            onPressed: () => Navigator.of(context).pop(controller.text.trim()),
            child: const Text('Continue'),
          ),
        ],
      ),
    ),
  );
}
