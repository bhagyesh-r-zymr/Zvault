import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/**
 * Bridge to local agent access (`zv` CLI). Rust owns the socket, the policy
 * and every key; the Agents screen lists agents, edits their access and
 * answers the prompts below. Secret values never reach this code: to resolve
 * a `zv://` reference the UI returns the encrypted item and Rust decrypts it.
 *
 * Mirrors `apps/desktop/src-tauri/src/agents.rs` and `crates/zvault-agent`.
 */

/** When an agent needs the user's approval. */
export type ApprovalMode = 'askEveryTime' | 'session15m' | 'whileUnlocked';

export const APPROVAL_MODE_TEXT: Record<ApprovalMode, string> = {
  askEveryTime: 'Ask every time (Touch ID)',
  session15m: 'Ask once per 15 minutes',
  whileUnlocked: 'Allow while Zvault is unlocked',
};

export interface Agent {
  id: string;
  name: string;
  /** Unix seconds. */
  createdAt: number;
  lastUsedAt: number | null;
  paused: boolean;
  approval: ApprovalMode;
  /** `zv://project/env/[folder/]item[#field]` or a prefix ending in `/*`. */
  scopes: string[];
}

export interface Purpose {
  kind: 'run' | 'read';
  /** Reported by the CLI; show it as the agent's claim. */
  command: string[];
  cwd: string | null;
}

export type ErrorCode =
  | 'badRequest'
  | 'unsupportedVersion'
  | 'unauthorized'
  | 'paused'
  | 'outOfScope'
  | 'locked'
  | 'denied'
  | 'timeout'
  | 'notFound'
  | 'busy'
  | 'internal';

export interface ActivityEntry {
  at: number;
  agentId: string;
  agentName: string;
  outcome: 'paired' | 'allowed' | 'approved' | 'denied' | 'unpaired';
  refs: string[];
  purpose: Purpose | null;
  reason: ErrorCode | null;
  verifiedBy: 'touchId' | 'click' | null;
  peerPid: number | null;
}

export interface ApprovalPrompt {
  requestId: string;
  agentId: string;
  agentName: string;
  refs: string[];
  purpose: Purpose;
  peerPid: number | null;
  approval: ApprovalMode;
  /** Approving also shows the system Touch ID sheet. */
  touchId: boolean;
  expiresInSecs: number;
}

export interface PairingPrompt {
  requestId: string;
  name: string;
  /** Also printed in the terminal that ran `zv agent pair`. */
  code: string;
  peerPid: number | null;
  expiresInSecs: number;
}

/** An encrypted item record, as `item_open` takes it. */
export interface ItemCipher {
  id: string;
  encryptedKey: unknown;
  encryptedData: unknown;
}

export interface ResolvedItem {
  reference: string;
  vaultId: string;
  item: ItemCipher;
}

export const agents = {
  accessStatus: () =>
    invoke<{ listening: boolean; socketPath: string | null }>('agent_access_status'),
  list: () => invoke<Agent[]>('agent_list'),
  update: (
    agentId: string,
    changes: { name?: string; paused?: boolean; approval?: ApprovalMode; scopes?: string[] },
  ) => invoke<Agent>('agent_update', { agentId, ...changes }),
  unpair: (agentId: string) => invoke<void>('agent_unpair', { agentId }),
  activity: (agentId?: string, limit?: number) =>
    invoke<ActivityEntry[]>('agent_activity', { agentId, limit }),
  approve: (requestId: string, approve: boolean) =>
    invoke<void>('agent_approval_respond', { requestId, approve }),
  answerPairing: (
    requestId: string,
    approve: boolean,
    access?: { approval: ApprovalMode; scopes: string[] },
  ) => invoke<void>('agent_pairing_respond', { requestId, approve, ...access }),

  onApprovalRequest: (handler: (p: ApprovalPrompt) => void): Promise<UnlistenFn> =>
    listen<ApprovalPrompt>('agent://approval-request', (e) => handler(e.payload)),
  onPairingRequest: (handler: (p: PairingPrompt) => void): Promise<UnlistenFn> =>
    listen<PairingPrompt>('agent://pairing-request', (e) => handler(e.payload)),
  /** A prompt was answered, timed out or withdrawn because Zvault locked. */
  onPromptClosed: (handler: (requestId: string) => void): Promise<UnlistenFn> =>
    listen<string>('agent://prompt-closed', (e) => handler(e.payload)),
  onActivity: (handler: () => void): Promise<UnlistenFn> =>
    listen('agent://activity', () => handler()),

  /**
   * Answers Rust's "where does this reference live?" requests. `find` returns
   * the encrypted item for a reference, or null if there is none. Register
   * once, while the vault is loaded.
   */
  serveResolves: (
    find: (reference: string) => Promise<{ vaultId: string; item: ItemCipher } | null>,
  ): Promise<UnlistenFn> =>
    listen<{ requestId: string; refs: string[] }>('agent://resolve-request', (e) => {
      void answerResolve(e.payload.requestId, e.payload.refs, find);
    }),
};

async function answerResolve(
  requestId: string,
  refs: string[],
  find: (reference: string) => Promise<{ vaultId: string; item: ItemCipher } | null>,
) {
  const items: ResolvedItem[] = [];
  for (const reference of refs) {
    const found = await find(reference).catch(() => null);
    if (found) items.push({ reference, ...found });
  }
  await invoke('agent_resolve_respond', { requestId, items });
}
