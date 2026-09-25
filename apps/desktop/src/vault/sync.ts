import type { ItemRecord, LiveItemRecord } from '@zvault/shared';
import { ConflictError, type VaultApi } from './api.js';
import type {
  ItemCipher,
  ItemFields,
  ItemSummary,
  OtpCode,
  VaultCore,
  VaultSummary,
} from './core.js';

export interface ListedItem {
  id: string;
  revision: number;
  summary: ItemSummary;
}

/**
 * Local view of one vault, kept in step with the server. It holds ciphertext
 * records and display summaries; full item fields are decrypted on demand.
 *
 * Writes use optimistic concurrency: each carries the revision it was based
 * on, and a write that lost a race surfaces as a {@link ConflictError} after
 * the local copy has been refreshed with the winning version.
 */
export class VaultSync {
  private readonly records = new Map<string, LiveItemRecord>();
  private readonly summaries = new Map<string, ItemSummary>();
  private readonly listeners = new Set<() => void>();
  private cursor = 0;
  private snapshot: ListedItem[] = [];
  /** Items whose ciphertext could not be decrypted (tampered or corrupt). */
  unreadable = 0;

  constructor(
    private readonly api: VaultApi,
    private readonly core: VaultCore,
    readonly vault: VaultSummary,
  ) {}

  /** Items sorted by title. Stable between changes, for `useSyncExternalStore`. */
  items = (): ListedItem[] => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Fetches every change since the last pull. */
  async pull(): Promise<void> {
    let hasMore = true;
    while (hasMore) {
      const page = await this.api.syncItems(this.vault.id, this.cursor);
      for (const record of page.items) await this.apply(record);
      this.cursor = page.cursor;
      hasMore = page.hasMore;
    }
    this.emit();
  }

  /** Decrypts an item's fields for display or editing. */
  open(itemId: string): Promise<ItemFields> {
    return this.core.openItem(this.vault.id, cipherOf(this.record(itemId)));
  }

  /** The item's current one-time password, computed in Rust from the saved item. */
  totpCode(itemId: string): Promise<OtpCode | null> {
    return this.core.totpCode(this.vault.id, cipherOf(this.record(itemId)));
  }

  /** Creates an item (`itemId` null) or saves an edit. Returns the item id. */
  async save(itemId: string | null, fields: ItemFields): Promise<string> {
    const existing = itemId === null ? null : this.record(itemId);
    const sealed = await this.core.sealItem(this.vault.id, existing && cipherOf(existing), fields);
    const saved = await this.write(() =>
      this.api.putItem(this.vault.id, sealed.id, {
        baseRevision: existing?.revision ?? 0,
        encryptedKey: sealed.encryptedKey,
        encryptedData: sealed.encryptedData,
      }),
    );
    return saved.id;
  }

  /**
   * The item whose id is `query`, or the one item titled `query` (ignoring
   * case). Throws when none or several match, for `zv item`.
   */
  find(query: string): ListedItem {
    const byId = this.snapshot.find((i) => i.id === query);
    if (byId) return byId;
    const wanted = query.trim().toLowerCase();
    const matches = this.snapshot.filter((i) => i.summary.title.trim().toLowerCase() === wanted);
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) throw new Error(`No item is called “${query}”.`);
    throw new Error(
      `${matches.length} items are called “${query}”; use its id (zv item list shows it).`,
    );
  }

  /** An item's ciphertext, for the Rust core to open. */
  cipher(itemId: string): ItemCipher {
    return cipherOf(this.record(itemId));
  }

  /** Uploads an item the Rust core already sealed (`zv item create` / `edit`). */
  async putSealed(sealed: ItemCipher): Promise<void> {
    const existing = this.records.get(sealed.id);
    await this.write(() =>
      this.api.putItem(this.vault.id, sealed.id, {
        baseRevision: existing?.revision ?? 0,
        encryptedKey: sealed.encryptedKey,
        encryptedData: sealed.encryptedData,
      }),
    );
  }

  async remove(itemId: string): Promise<void> {
    const existing = this.record(itemId);
    await this.write(() => this.api.deleteItem(this.vault.id, itemId, existing.revision));
  }

  private async write(send: () => Promise<ItemRecord>): Promise<ItemRecord> {
    try {
      const record = await send();
      await this.apply(record);
      return record;
    } catch (e) {
      if (e instanceof ConflictError) await this.apply(e.current);
      throw e;
    } finally {
      this.emit();
    }
  }

  private record(itemId: string): LiveItemRecord {
    const record = this.records.get(itemId);
    if (!record) throw new Error('This item no longer exists.');
    return record;
  }

  private async apply(record: ItemRecord): Promise<void> {
    const known = this.records.get(record.id);
    if (known && known.revision >= record.revision) return;
    if (record.deleted) {
      this.records.delete(record.id);
      this.summaries.delete(record.id);
      return;
    }
    try {
      const summary = await this.core.summarizeItem(this.vault.id, cipherOf(record));
      this.records.set(record.id, record);
      this.summaries.set(record.id, summary);
    } catch {
      this.unreadable += 1;
    }
  }

  private emit(): void {
    this.snapshot = [...this.records.values()]
      .map((r) => ({ id: r.id, revision: r.revision, summary: this.summaries.get(r.id)! }))
      .sort((a, b) => a.summary.title.localeCompare(b.summary.title));
    for (const listener of this.listeners) listener();
  }
}

const opening = new WeakMap<VaultApi, Promise<VaultSummary>>();

/**
 * Opens the account's first vault, creating a "Personal" vault on first use.
 * Calls that overlap share one request, so two quick mounts (StrictMode, or
 * switching views during sign-in) can't each create a "Personal" vault.
 */
export function openDefaultVault(api: VaultApi, core: VaultCore): Promise<VaultSummary> {
  let pending = opening.get(api);
  if (!pending) {
    pending = openOrCreate(api, core).finally(() => opening.delete(api));
    opening.set(api, pending);
  }
  return pending;
}

async function openOrCreate(api: VaultApi, core: VaultCore): Promise<VaultSummary> {
  const [first] = await api.listVaults();
  if (first) return core.openVault(first);
  const { record, summary } = await core.createVault('Personal');
  await api.createVault(record);
  return summary;
}

function cipherOf(record: LiveItemRecord): ItemCipher {
  return { id: record.id, encryptedKey: record.encryptedKey, encryptedData: record.encryptedData };
}
