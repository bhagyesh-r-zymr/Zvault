import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app_state.dart';
import '../theme.dart';
import '../widgets.dart';

class SettingsTab extends StatelessWidget {
  const SettingsTab({super.key});

  // ListTile gives trailing text the small caps label style; keep it body text.
  static const _trailing = TextStyle(
    color: Zv.text2,
    fontSize: 14,
    fontWeight: FontWeight.w400,
    letterSpacing: 0,
  );

  static const _autoLock = {1: '1 minute', 5: '5 minutes', 15: '15 minutes', 60: '1 hour'};

  Future<void> _pickAutoLock(BuildContext context, AppState app) async {
    final current = app.account?.autoLockMinutes ?? 1;
    final picked = await showModalBottomSheet<int>(
      context: context,
      backgroundColor: Zv.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(Zv.radiusXl)),
      ),
      builder: (context) => SafeArea(
        child: RadioGroup<int>(
          groupValue: current,
          onChanged: (v) => Navigator.of(context).pop(v),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Padding(
                padding: EdgeInsets.fromLTRB(20, 20, 20, 8),
                child: Text(
                  'Lock after leaving Zvault for',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                ),
              ),
              for (final e in _autoLock.entries)
                RadioListTile<int>(value: e.key, title: Text(e.value)),
              const SizedBox(height: 8),
            ],
          ),
        ),
      ),
    );
    if (picked != null) await app.setAutoLock(picked);
  }

  Future<void> _confirmSignOut(BuildContext context, AppState app) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: Zv.surface,
        title: const Text('Sign out of this phone?'),
        content: const Text(
          'Your keys are removed from this phone. To sign in again, scan a new code on your Mac.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(true),
            style: TextButton.styleFrom(foregroundColor: Zv.danger),
            child: const Text('Sign out'),
          ),
        ],
      ),
    );
    if (ok == true) await app.signOut();
  }

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final a = app.account;
    final minutes = a?.autoLockMinutes ?? 1;
    return SafeArea(
      bottom: false,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
        children: [
          Text('Settings', style: Theme.of(context).textTheme.headlineMedium),
          const SizedBox(height: 20),
          Panel(
            padding: const EdgeInsets.all(16),
            child: Row(
              children: [
                LetterTile(a?.email ?? '?', size: 44),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        a?.email ?? '',
                        style: const TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w500,
                          color: Zv.text,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        Uri.tryParse(a?.api ?? '')?.host ?? '',
                        style: const TextStyle(fontSize: 13, color: Zv.text2),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),
          const SectionLabel('Security'),
          Panel(
            child: Column(
              children: [
                ListTile(
                  leading: const Icon(Icons.fingerprint_rounded, color: Zv.text2),
                  title: const Text('Fingerprint unlock'),
                  trailing: _Pill(on: a?.quickUnlock == true),
                ),
                const Divider(),
                ListTile(
                  key: const Key('auto-lock'),
                  leading: const Icon(Icons.timer_outlined, color: Zv.text2),
                  title: const Text('Auto-lock'),
                  trailing: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(_autoLock[minutes] ?? '$minutes minutes', style: _trailing),
                      const Icon(Icons.chevron_right_rounded, color: Zv.muted),
                    ],
                  ),
                  onTap: () => _pickAutoLock(context, app),
                ),
                const Divider(),
                ListTile(
                  leading: const Icon(Icons.lock_outline_rounded, color: Zv.text2),
                  title: const Text('Lock now'),
                  onTap: app.lock,
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),
          const SectionLabel('This phone'),
          Panel(
            child: Column(
              children: [
                ListTile(
                  leading: const Icon(Icons.sync_rounded, color: Zv.text2),
                  title: const Text('Last synced'),
                  trailing: Text(_ago(app.lastSynced), style: _trailing),
                  onTap: app.sync,
                ),
                const Divider(),
                ListTile(
                  leading: const Icon(Icons.info_outline_rounded, color: Zv.text2),
                  title: const Text('Version'),
                  trailing: const Text(appVersion, style: _trailing),
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),
          OutlinedButton(
            key: const Key('sign-out'),
            onPressed: () => _confirmSignOut(context, app),
            style: OutlinedButton.styleFrom(
              foregroundColor: Zv.danger,
              side: const BorderSide(color: Zv.dangerLine),
            ),
            child: const Text('Sign out of this phone'),
          ),
          const SizedBox(height: 12),
          const Text(
            'Read-only on phones for now. Add and edit on your Mac.',
            textAlign: TextAlign.center,
            style: TextStyle(color: Zv.muted, fontSize: 13),
          ),
        ],
      ),
    );
  }

  static String _ago(DateTime? at) {
    if (at == null) return 'Not yet';
    final d = DateTime.now().difference(at);
    if (d.inMinutes < 1) return 'Just now';
    if (d.inHours < 1) return '${d.inMinutes} min ago';
    return '${d.inHours} h ago';
  }
}

class _Pill extends StatelessWidget {
  const _Pill({required this.on});

  final bool on;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: on ? Zv.secureBg : Zv.sunken,
        borderRadius: BorderRadius.circular(99),
        border: Border.all(color: on ? Zv.secureLine : Zv.line),
      ),
      child: Text(
        on ? 'On' : 'Off',
        style: TextStyle(fontSize: 12, color: on ? Zv.secure : Zv.muted),
      ),
    );
  }
}
