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
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
          children: [
            Row(
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
            const SizedBox(height: 16),
            if (app.syncError != null) ...[ErrorBanner(app.syncError!), const SizedBox(height: 12)],
            if (app.projects.isEmpty && !app.syncing)
              const EmptyState(
                icon: Icons.layers_clear_outlined,
                title: 'No projects yet',
                body: 'Projects you create or join on your Mac show up here.',
              ),
            for (final p in app.projects) ...[_ProjectCard(p), const SizedBox(height: 12)],
          ],
        ),
      ),
    );
  }
}

class _ProjectCard extends StatelessWidget {
  const _ProjectCard(this.project);

  final Project project;

  @override
  Widget build(BuildContext context) {
    final color = hexColor(project.color) ?? Zv.iris;
    return Panel(
      child: InkWell(
        onTap: () =>
            Navigator.of(context)
                .push(MaterialPageRoute(builder: (_) => ProjectDetailScreen(project: project))),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    width: 36,
                    height: 36,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: color.withValues(alpha: 0.18),
                      borderRadius: BorderRadius.circular(Zv.radiusS),
                      border: Border.all(color: color.withValues(alpha: 0.45)),
                    ),
                    child: Text(
                      project.name.isEmpty ? '?' : project.name[0].toUpperCase(),
                      style: TextStyle(color: color, fontWeight: FontWeight.w600, fontSize: 16),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(project.name, style: Theme.of(context).textTheme.titleMedium),
                        if (project.slug.isNotEmpty)
                          Text(
                            project.slug,
                            style: Zv.monoStyle.copyWith(fontSize: 12, color: Zv.muted),
                          ),
                      ],
                    ),
                  ),
                  Text(
                    '${project.secrets.length} secrets',
                    style: const TextStyle(color: Zv.text2, fontSize: 13),
                  ),
                ],
              ),
              if (project.description?.isNotEmpty == true) ...[
                const SizedBox(height: 10),
                Text(project.description!, style: Theme.of(context).textTheme.bodyMedium),
              ],
              if (project.environments.isNotEmpty) ...[
                const SizedBox(height: 12),
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [for (final e in project.environments) EnvBadge(e)],
                ),
              ],
            ],
          ),
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
    final color = hexColor(env.color) ?? Zv.text2;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: Zv.sunken,
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: Zv.line),
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
            const Icon(Icons.lock_rounded, size: 11, color: Zv.muted),
          const SizedBox(width: 6),
          Text(env.name, style: TextStyle(fontSize: 12, color: env.unlocked ? Zv.text : Zv.muted)),
        ],
      ),
    );
  }
}
