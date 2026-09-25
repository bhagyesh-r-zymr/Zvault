import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app_state.dart';
import '../theme.dart';
import '../widgets.dart';
import 'home.dart';
import 'item_detail.dart';

class ItemsTab extends StatefulWidget {
  const ItemsTab({super.key});

  @override
  State<ItemsTab> createState() => _ItemsTabState();
}

class _ItemsTabState extends State<ItemsTab> {
  String _query = '';

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final q = _query.trim().toLowerCase();
    final items = q.isEmpty
        ? app.items
        : app.items.where((i) {
            final s = i.summary;
            return s.title.toLowerCase().contains(q) ||
                s.username.toLowerCase().contains(q) ||
                (s.url ?? '').toLowerCase().contains(q);
          }).toList();
    return SafeArea(
      bottom: false,
      child: RefreshIndicator(
        onRefresh: app.sync,
        child: CustomScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Text('Items', style: Theme.of(context).textTheme.headlineMedium),
                        const SizedBox(width: 10),
                        if (app.items.isNotEmpty)
                          Text(
                            '${app.items.length}',
                            style: const TextStyle(color: Zv.muted, fontSize: 16),
                          ),
                        const Spacer(),
                        if (app.syncing)
                          const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          ),
                      ],
                    ),
                    const SizedBox(height: 14),
                    TextField(
                      key: const Key('items-search'),
                      onChanged: (v) => setState(() => _query = v),
                      decoration: const InputDecoration(
                        hintText: 'Search items',
                        prefixIcon: Icon(Icons.search_rounded, color: Zv.muted),
                      ),
                    ),
                    if (app.syncError != null) ...[
                      const SizedBox(height: 12),
                      ErrorBanner(app.syncError!),
                    ],
                  ],
                ),
              ),
            ),
            if (items.isEmpty && !app.syncing)
              SliverToBoxAdapter(
                child: q.isEmpty
                    ? const EmptyState(
                        icon: Icons.key_off_outlined,
                        title: 'No items yet',
                        body: 'Items you add on your Mac show up here.',
                      )
                    : EmptyState(
                        icon: Icons.search_off_rounded,
                        title: 'Nothing matches “$_query”',
                        body: 'Try a name, username or website.',
                      ),
              )
            else
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(12, 0, 12, 24),
                sliver: SliverList.builder(
                  itemCount: items.length,
                  itemBuilder: (context, i) => _ItemRow(items[i]),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _ItemRow extends StatelessWidget {
  const _ItemRow(this.item);

  final VaultItem item;

  @override
  Widget build(BuildContext context) {
    final s = item.summary;
    final subtitle = s.username.isNotEmpty ? s.username : (s.url ?? item.vaultName);
    return InkWell(
      borderRadius: BorderRadius.circular(Zv.radiusM),
      onTap: () =>
          Navigator.of(context)
              .push(MaterialPageRoute(builder: (_) => ItemDetailScreen(item: item))),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
        child: Row(
          children: [
            LetterTile(s.title),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    s.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w500),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    subtitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 14, color: Zv.text2),
                  ),
                ],
              ),
            ),
            if (s.hasTotp)
              const Padding(
                padding: EdgeInsets.only(left: 8),
                child: Icon(Icons.timer_outlined, size: 18, color: Zv.irisText),
              ),
            const Icon(Icons.chevron_right_rounded, color: Zv.muted),
          ],
        ),
      ),
    );
  }
}
