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
    final c = context.zv;
    final q = _query.trim().toLowerCase();
    final items = q.isEmpty
        ? app.items
        : app.items.where((i) {
            final s = i.summary;
            return s.title.toLowerCase().contains(q) ||
                s.username.toLowerCase().contains(q) ||
                (s.url ?? '').toLowerCase().contains(q);
          }).toList();
    final pill = OutlineInputBorder(
      borderRadius: BorderRadius.circular(99),
      borderSide: BorderSide(color: c.line),
    );
    return SafeArea(
      bottom: false,
      child: RefreshIndicator(
        onRefresh: app.sync,
        child: CustomScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 14, 20, 14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.baseline,
                      textBaseline: TextBaseline.alphabetic,
                      children: [
                        Text('Items', style: Theme.of(context).textTheme.headlineMedium),
                        const SizedBox(width: 10),
                        if (app.items.isNotEmpty)
                          Text(
                            '${app.items.length}',
                            style: TextStyle(
                              color: c.muted,
                              fontSize: 15,
                              fontWeight: FontWeight.w500,
                            ),
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
                    const SizedBox(height: 12),
                    TextField(
                      key: const Key('items-search'),
                      onChanged: (v) => setState(() => _query = v),
                      decoration: InputDecoration(
                        hintText: 'Search items',
                        isDense: true,
                        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                        prefixIcon: const Icon(Icons.search_rounded, size: 20),
                        border: pill,
                        enabledBorder: pill,
                        focusedBorder: pill.copyWith(
                          borderSide: BorderSide(color: c.accent, width: 1.5),
                        ),
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
            else if (items.isNotEmpty)
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
                // One rounded card around the whole list, rows split by lines.
                sliver: DecoratedSliver(
                  decoration: ShapeDecoration(
                    color: c.panel,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(Zv.radiusL),
                      side: BorderSide(color: c.line),
                    ),
                  ),
                  sliver: SliverList.separated(
                    itemCount: items.length,
                    separatorBuilder: (context, i) => const Divider(indent: 62),
                    itemBuilder: (context, i) =>
                        _ItemRow(items[i], first: i == 0, last: i == items.length - 1),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _ItemRow extends StatelessWidget {
  const _ItemRow(this.item, {required this.first, required this.last});

  final VaultItem item;
  final bool first;
  final bool last;

  @override
  Widget build(BuildContext context) {
    final c = context.zv;
    final s = item.summary;
    final subtitle = s.username.isNotEmpty ? s.username : (s.url ?? item.vaultName);
    const r = Radius.circular(Zv.radiusL);
    return Material(
      type: MaterialType.transparency,
      child: InkWell(
        customBorder: RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(
            top: first ? r : Radius.zero,
            bottom: last ? r : Radius.zero,
          ),
        ),
        onTap: () =>
            Navigator.of(context)
                .push(MaterialPageRoute(builder: (_) => ItemDetailScreen(item: item))),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 11, 8, 11),
          child: Row(
            children: [
              LetterTile(s.title),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      s.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: c.ink),
                    ),
                    const SizedBox(height: 1),
                    Text(
                      subtitle,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 13, color: c.muted),
                    ),
                  ],
                ),
              ),
              if (s.hasPasskey)
                Padding(
                  padding: const EdgeInsets.only(left: 8),
                  child: Icon(
                    Icons.fingerprint_rounded,
                    key: Key('passkey-${item.id}'),
                    size: 18,
                    color: c.accent,
                  ),
                ),
              if (s.hasTotp)
                Padding(
                  padding: const EdgeInsets.only(left: 8),
                  child: Icon(Icons.timer_outlined, size: 18, color: c.accent),
                ),
              Icon(Icons.chevron_right_rounded, color: c.muted),
            ],
          ),
        ),
      ),
    );
  }
}
