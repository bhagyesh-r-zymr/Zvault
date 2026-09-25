import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { EncryptedBlob, EnvironmentKind } from '@zvault/shared';
import type { ItemCipher } from '../vault/core.js';

/**
 * Bridge to the `zv` CLI. Rust owns the socket, the policy and every key; the
 * UI lists agents, edits their access, answers the prompts below and tells
 * Rust where `zv://` references live. Secret values never reach this code:
 * the UI hands Rust encrypted values, and for `zv set` uploads what Rust
 * sealed.
 *
 * Requests come from a paired agent (`principal: 'agent'`) or from the user
 * at a terminal (`principal: 'user'`, shown as "You (terminal)").
 *
 * Mirrors `apps/desktop/src-tauri/src/agents.rs` and `crates/zvault-agent`.
 */

/** Whether `zv` is installed from this app. */
export interface CliStatus {
  bundled: boolean;
  installedAt: string | null;
  onPath: boolean;
  command: string | null;
}

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
  /** `zv://project/environment/[folder/]KEY`, or a place ending in `/*`. */
  scopes: string[];
}

export type PurposeKind =
  | 'run'
  | 'read'
  | 'export'
  | 'list'
  | 'copy'
  | 'set'
  | 'signIn'
  | 'change'
  | 'readItem'
  | 'changeItem';

export interface Purpose {
  kind: PurposeKind;
  /** Reported by the CLI; show it as the agent's claim. */
  command: string[];
  cwd: string | null;
  /** What a change does, written by Zvault from the change itself. */
  detail?: string | null;
  /** The change deletes something. */
  destructive?: boolean;
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
  | 'agentsOnly'
  | 'userOnly'
  | 'rejected'
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
  principal: 'agent' | 'user';
  /** Null for the user. */
  agentId: string | null;
  agentName: string;
  /** Empty for sign-in and listing. */
  refs: string[];
  purpose: Purpose;
  peerPid: number | null;
  /** The agent's mode; null for the user. */
  approval: ApprovalMode | null;
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

/** A ciphertext in the `EncryptedBlob` wire format of `@zvault/shared`. */
export type Blob = EncryptedBlob;

/**
 * Where a `zv://project/environment/[folder/]KEY` path lives. The UI opens
 * the project and environment (`project_open`, `environment_open`) before
 * answering, so Rust holds their keys.
 */
export interface ResolvedSecret {
  /** The path, exactly as asked. */
  reference: string;
  projectId: string;
  environmentId: string;
  /** Null when no secret has that KEY there yet (`zv set` creates it). */
  secretId: string | null;
  /** For a new secret: the folder it goes in. */
  folderId: string | null;
  /** The value record for that environment, or null if it has none. */
  encryptedValue: Blob | null;
  /** When the value is inherited, the environment it was sealed for. */
  valueEnvironmentId?: string | null;
}

/** Resolves a path, or null if its project, environment or folder does not exist. */
export type FindSecret = (reference: string) => Promise<Omit<ResolvedSecret, 'reference'> | null>;

/** Every secret path under a prefix such as `zv://web/development/*` (all when null) that has a value. */
export type ListSecrets = (prefix: string | null) => Promise<string[]>;

/**
 * Saves what Rust sealed for `zv set`: `PUT` the secret with
 * `values[environmentId] = encryptedValue`, and `encryptedMeta` when it is
 * new (otherwise keep the current meta). Throw to report failure.
 */
export type SaveSecret = (write: {
  reference: string;
  projectId: string;
  environmentId: string;
  secretId: string;
  encryptedValue: Blob;
  encryptedMeta: Blob | null;
  created: boolean;
}) => Promise<void>;

/** A project as `zv projects` lists it: names only. Mirrors `manage::ProjectInfo`. */
export interface ProjectInfo {
  slug: string;
  name: string;
  owner: boolean;
  environments: {
    slug: string;
    name: string;
    kind: EnvironmentKind;
    /** Slug of the environment it falls back to. */
    inheritsFrom: string | null;
    locked: boolean;
  }[];
  folders: { slug: string; name: string }[];
}

/**
 * One change `zv` asks for, already approved by the person in Zvault.
 * Projects, environments and folders are named by slug. Mirrors
 * `manage::Change` in `crates/zvault-agent`.
 */
export type Change =
  | { op: 'createProject'; name: string; slug: string | null; environments: string[] }
  | { op: 'updateProject'; project: string; name: string | null; slug: string | null }
  | { op: 'deleteProject'; project: string }
  | {
      op: 'createEnvironment';
      project: string;
      name: string;
      slug: string | null;
      kind: EnvironmentKind | null;
      inheritsFrom: string | null;
    }
  | {
      op: 'updateEnvironment';
      project: string;
      environment: string;
      name: string | null;
      slug: string | null;
      kind: EnvironmentKind | null;
      inheritsFrom: string | null;
      noFallback: boolean;
    }
  | { op: 'deleteEnvironment'; project: string; environment: string }
  | { op: 'createFolder'; project: string; name: string; slug: string | null }
  | {
      op: 'updateFolder';
      project: string;
      folder: string;
      name: string | null;
      slug: string | null;
    }
  | { op: 'deleteFolder'; project: string; folder: string }
  | { op: 'deleteSecret'; reference: string; allEnvironments: boolean };

/** Makes a change and returns what it did, for the terminal. Throw to refuse it. */
export type ApplyChange = (change: Change) => Promise<string>;

/** A vault item as `zv item list` shows it: never its password. */
export interface ItemInfo {
  id: string;
  title: string;
  username: string;
  url: string | null;
  hasTotp: boolean;
}

/** What Rust asks of the personal vault for `zv item`. Mirrors `ItemOp` in server.rs. */
export type ItemOp =
  | { op: 'list' }
  | { op: 'vault' }
  | { op: 'find'; item: string }
  | { op: 'upload'; vaultId: string; item: ItemCipher; created: boolean }
  | { op: 'delete'; item: string };

/** The answer to an {@link ItemOp}; only ciphertext and summaries, never a password. */
export interface ItemReply {
  items?: ItemInfo[];
  vaultId?: string;
  item?: ItemCipher;
  message?: string;
}

export type HandleItem = (op: ItemOp) => Promise<ItemReply>;

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
  /** `zv` is waiting for Zvault to be unlocked; Rust also brings the window forward. */
  onUnlockRequested: (handler: () => void): Promise<UnlistenFn> =>
    listen('agent://unlock-requested', () => handler()),

  /** Whether this build ships `zv`, where it is linked, and a terminal command that links it. */
  cliStatus: () => invoke<CliStatus>('cli_status'),
  /**
   * Links the bundled `zv` onto the PATH. With `admin`, macOS asks for an
   * administrator password and links it in /usr/local/bin. Show `pathLine`
   * when `onPath` is false.
   */
  installCli: (admin = false) =>
    invoke<{ path: string; onPath: boolean; pathLine: string | null }>('cli_install', { admin }),

  /** Answers Rust's `zv ls` / `zv env` lookups. Register once, while the vault is loaded. */
  serveLists: (list: ListSecrets): Promise<UnlistenFn> =>
    listen<{ requestId: string; prefix: string | null }>('agent://list-request', (e) => {
      void answerList(e.payload.requestId, e.payload.prefix, list);
    }),
  /** Saves items for `zv set`. Register once, while the vault is loaded. */
  serveWrites: (save: SaveSecret): Promise<UnlistenFn> =>
    listen<Parameters<SaveSecret>[0] & { requestId: string }>('agent://write-request', (e) => {
      const { requestId, ...write } = e.payload;
      void answerWrite(requestId, write, save);
    }),

  /** Answers `zv projects` with every project's environments and folders, by name. */
  serveStructure: (describe: () => Promise<ProjectInfo[]>): Promise<UnlistenFn> =>
    listen<{ requestId: string }>('agent://structure-request', (e) => {
      void answer(e.payload.requestId, describe, () => []);
    }),
  /** Makes the project, environment, folder and secret changes `zv` asks for. */
  serveChanges: (apply: ApplyChange): Promise<UnlistenFn> =>
    listen<{ requestId: string; change: Change }>('agent://change-request', (e) => {
      void answer(
        e.payload.requestId,
        async () => ({ message: await apply(e.payload.change) }),
        (error) => ({ error }),
      );
    }),
  /** Finds, lists, uploads and deletes personal vault items for `zv item`. */
  serveItems: (handle: HandleItem): Promise<UnlistenFn> =>
    listen<{ requestId: string } & ItemOp>('agent://item-request', (e) => {
      const { requestId, ...op } = e.payload;
      void answer(
        requestId,
        () => handle(op),
        (error) => ({ error }),
      );
    }),

  /**
   * Answers Rust's "where does this path live?" requests. Register once,
   * while projects are loaded.
   */
  serveResolves: (find: FindSecret): Promise<UnlistenFn> =>
    listen<{ requestId: string; refs: string[] }>('agent://resolve-request', (e) => {
      void answerResolve(e.payload.requestId, e.payload.refs, find);
    }),
};

/** Sends `work`'s result to Rust, or what `failed` makes of its error. */
async function answer(
  requestId: string,
  work: () => Promise<unknown>,
  failed: (message: string) => unknown,
) {
  let reply: unknown;
  try {
    reply = await work();
  } catch (e) {
    reply = failed(e instanceof Error ? e.message : String(e));
  }
  await invoke('agent_ui_respond', { requestId, reply });
}

async function answerResolve(requestId: string, refs: string[], find: FindSecret) {
  const items: ResolvedSecret[] = [];
  for (const reference of refs) {
    const found = await find(reference).catch(() => null);
    if (found) items.push({ reference, ...found });
  }
  await invoke('agent_resolve_respond', { requestId, items });
}

async function answerList(requestId: string, prefix: string | null, list: ListSecrets) {
  const refs = await list(prefix).catch(() => []);
  await invoke('agent_list_respond', { requestId, refs });
}

async function answerWrite(requestId: string, write: Parameters<SaveSecret>[0], save: SaveSecret) {
  let error: string | null = null;
  try {
    await save(write);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  await invoke('agent_write_respond', { requestId, error });
}
