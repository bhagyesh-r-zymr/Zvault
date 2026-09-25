import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app_state.dart';
import '../theme.dart';
import '../widgets.dart';

class ProjectDetailScreen extends StatefulWidget {
  const ProjectDetailScreen({
    super.key,
    required this.project,
    this.initialEnvironment = 0,
    this.revealAll = false,
  });

  final Project project;
  final int initialEnvironment;

  /// Starts with every value shown. For screenshots and tests.
  final bool revealAll;

  @override
  State<ProjectDetailScreen> createState() => _ProjectDetailScreenState();
}

class _ProjectDetailScreenState extends State<ProjectDetailScreen> {
  late int _env = widget.initialEnvironment.clamp(
    0,
    (widget.project.environments.length - 1).clamp(0, 999),
  );

  /// Opened values for the current environment, by secret id.
  final _values = <String, String>{};

  @override
  void initState() {
    super.initState();
    if (widget.revealAll) WidgetsBinding.instance.addPostFrameCallback((_) => _revealAll());
  }

  Environment? get _current =>
      widget.project.environments.isEmpty ? null : widget.project.environments[_env];

  Future<void> _revealAll() async {
    for (final s in widget.project.secrets) {
      await _open(s);
    }
  }

  Future<String?> _open(Secret s) async {
    final env = _current;
    if (env == null || !env.unlocked) return null;
    final have = _values[s.id];
    if (have != null) return have;
    try {
      final v = await context.read<AppState>().openSecret(widget.project, s, env);
      if (mounted) setState(() => _values[s.id] = v);
      return v;
    } catch (_) {
      if (mounted) showToast(context, "Couldn't open ${s.key}.");
      return null;
    }
  }

  Future<void> _toggle(Secret s) async {
    if (_values.containsKey(s.id)) {
      setState(() => _values.remove(s.id));
    } else {
      await _open(s);
    }
  }

  Future<void> _copy(Secret s) async {
    final v = await _open(s);
    if (v == null) return;
    await SecureClipboard.copy(v);
    if (mounted) showToast(context, '${s.key} copied. Clears in a minute.');
  }

  @override
  Widget build(BuildContext context) {
    final c = context.zv;
    final p = widget.project;
    final env = _current;
    final groups = <String?, List<Secret>>{};
    for (final s in p.secrets) {
      final folder = p.folders.containsKey(s.folderId) ? s.folderId : null;
      groups.putIfAbsent(folder, () => []).add(s);
    }
    final order = [
      if (groups.containsKey(null)) null,
      ...groups.keys.whereType<String>().toList()
        ..sort((a, b) => p.folders[a]!.name.compareTo(p.folders[b]!.name)),
    ];
    return Scaffold(
      appBar: AppBar(title: Text(p.name)),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 32),
          children: [
            if (p.environments.isNotEmpty)
              SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(
                  children: [
                    for (final (i, e) in p.environments.indexed)
                      Padding(
                        padding: const EdgeInsets.only(right: 8),
                        child: ChoiceChip(
                          key: Key('env-${e.slug}'),
                          selected: i == _env,
                          showCheckmark: false,
                          avatar: e.unlocked
                              ? Container(
                                  width: 8,
                                  height: 8,
                                  decoration: BoxDecoration(
                                    color: hexColor(e.color) ?? c.muted,
                                    shape: BoxShape.circle,
                                  ),
                                )
                              : Icon(Icons.lock_rounded, size: 14, color: c.muted),
                          label: Text(e.name),
                          onSelected: (_) => setState(() {
                            _env = i;
                            _values.clear();
                          }),
                        ),
                      ),
                  ],
                ),
              ),
            const SizedBox(height: 16),
            if (env != null && !env.unlocked) ...[
              Notice(
                tone: ZvTone.attention,
                icon: Icons.lock_outline_rounded,
                text: "You don't have access to ${env.name}. Ask a project admin on the Mac.",
              ),
              const SizedBox(height: 16),
            ],
            if (p.secrets.isEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 48),
                child: Text(
                  'No secrets in this project yet.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: c.muted),
                ),
              ),
            for (final folder in order) ...[
              SectionLabel(folder == null ? 'Secrets' : p.folders[folder]!.name),
              Panel(
                child: Column(
                  children: [
                    for (final (i, s) in groups[folder]!.indexed) ...[
                      if (i > 0) const Divider(),
                      _SecretRow(
                        secret: s,
                        value: _values[s.id],
                        readable: env?.unlocked == true && s.values.containsKey(env!.id),
                        onToggle: () => _toggle(s),
                        onCopy: () => _copy(s),
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: 20),
            ],
          ],
        ),
      ),
    );
  }
}

class _SecretRow extends StatelessWidget {
  const _SecretRow({
    required this.secret,
    required this.value,
    required this.readable,
    required this.onToggle,
    required this.onCopy,
  });

  final Secret secret;
  final String? value;
  final bool readable;
  final VoidCallback onToggle;
  final VoidCallback onCopy;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 10, 4, 10),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  secret.key,
                  style: Zv.monoStyle.copyWith(fontSize: 12.5, color: context.zv.muted),
                ),
                const SizedBox(height: 3),
                if (!readable)
                  Text('Not set here', style: TextStyle(color: context.zv.muted, fontSize: 13))
                else if (value != null)
                  SecretText(value!, size: 14)
                else
                  const SecretText('••••••••••••', masked: true, size: 14),
              ],
            ),
          ),
          if (readable) ...[
            IconButton(
              tooltip: value == null ? 'Show' : 'Hide',
              onPressed: onToggle,
              icon: Icon(
                value == null ? Icons.visibility_outlined : Icons.visibility_off_outlined,
                size: 20,
              ),
            ),
            IconButton(
              tooltip: 'Copy',
              onPressed: onCopy,
              icon: const Icon(Icons.copy_rounded, size: 19),
            ),
          ],
        ],
      ),
    );
  }
}
