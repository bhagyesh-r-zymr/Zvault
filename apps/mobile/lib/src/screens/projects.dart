import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app_state.dart';
import '../theme.dart';
import '../widgets.dart';
import 'home.dart';
import 'project_detail.dart';

class ProjectsTab extends StatelessWidget {
  const ProjectsTab({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    return SafeArea(
      bottom: false,
      child: RefreshIndicator(
        onRefresh: app.sync,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: Row(
                children: [
                  Text('Projects', style: Theme.of(context).textTheme.headlineMedium),
                  const Spacer(),
                  if (app.syncing)
                    const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 14),
            if (app.syncError != null) ...[ErrorBanner(app.syncError!), const SizedBox(height: 12)],
            if (app.projects.isEmpty && !app.syncing)
              const EmptyState(
                icon: Icons.layers_clear_outlined,
                title: 'No projects yet',
                body: 'Projects you create or join on your Mac show up here.',
              ),
            if (app.projects.isNotEmpty)
              Panel(
                child: Column(
                  children: [
                    for (final (i, p) in app.projects.indexed) ...[
                      if (i > 0) const Divider(),
                      _ProjectRow(p),
                    ],
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _ProjectRow extends StatelessWidget {
  const _ProjectRow(this.project);

  final Project project;

  @override
  Widget build(BuildContext context) {
    final c = context.zv;
    final (bg, fg) = project.tile;
    return InkWell(
      onTap: () =>
          Navigator.of(context)
              .push(MaterialPageRoute(builder: (_) => ProjectDetailScreen(project: project))),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 12, 10, 12),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 36,
              height: 36,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: hexColor(bg),
                borderRadius: BorderRadius.circular(Zv.radiusS),
              ),
              child: Text(
                project.name.isEmpty ? '?' : project.name[0].toUpperCase(),
                style: TextStyle(
                  fontFamily: Zv.display,
                  color: hexColor(fg),
                  fontWeight: FontWeight.w800,
                  fontSize: 16,
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          project.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: c.ink),
                        ),
                      ),
                      Text(
                        project.secrets.length == 1
                            ? '1 secret'
                            : '${project.secrets.length} secrets',
                        style: TextStyle(color: c.muted, fontSize: 12.5),
                      ),
                    ],
                  ),
                  if (project.slug.isNotEmpty)
                    Text(project.slug, style: Zv.monoStyle.copyWith(fontSize: 12, color: c.muted)),
                  if (project.description?.isNotEmpty == true) ...[
                    const SizedBox(height: 6),
                    Text(
                      project.description!,
                      style: TextStyle(fontSize: 13.5, color: c.muted, height: 1.4),
                    ),
                  ],
                  if (project.environments.isNotEmpty) ...[
                    const SizedBox(height: 10),
                    Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      children: [for (final e in project.environments) EnvBadge(e)],
                    ),
                  ],
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.only(left: 4, top: 6),
              child: Icon(Icons.chevron_right_rounded, color: c.muted),
            ),
          ],
        ),
      ),
    );
  }
}

/// An environment name in its colour, with a lock when this account can't read it.
class EnvBadge extends StatelessWidget {
  const EnvBadge(this.env, {super.key});

  final Environment env;

  @override
  Widget build(BuildContext context) {
    final c = context.zv;
    final color = hexColor(env.color) ?? c.muted;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
      decoration: BoxDecoration(
        color: c.well,
        borderRadius: BorderRadius.circular(99),
        border: Border.all(color: c.line),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (env.unlocked)
            Container(
              width: 7,
              height: 7,
              decoration: BoxDecoration(color: color, shape: BoxShape.circle),
            )
          else
            Icon(Icons.lock_rounded, size: 11, color: c.muted),
          const SizedBox(width: 6),
          Text(
            env.name,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w500,
              color: env.unlocked ? c.ink : c.muted,
            ),
          ),
        ],
      ),
    );
  }
}
