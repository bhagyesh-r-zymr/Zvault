import { z } from 'zod';
import { EncryptedBlob } from './crypto.js';
import { base64UrlOfLength } from './encoding.js';
import { SharingPublicKey } from './sharing.js';

/**
 * Team access contracts: organizations, members, groups, agents, and who can
 * reach each environment of a project.
 *
 * Access is enforced twice. The server checks a principal's level before it
 * hands out anything, and each environment's key is only ever wrapped (on a
 * manager's device) to the X25519 key of someone with standing access, so the
 * server never holds a key that opens an environment.
 */

const Uuid = z.uuid();
const IsoDate = z.iso.datetime();

const OrgId = Uuid;
const GroupId = Uuid;
const AgentId = Uuid;
const EnvironmentId = Uuid;
const ProjectId = Uuid;
const AccessRequestId = Uuid;

/** Owners and admins manage members, groups and agents; owners also manage admins. */
export const OrgRole = z.enum(['owner', 'admin', 'member']);
export type OrgRole = z.infer<typeof OrgRole>;

/**
 * What a principal may do in one environment, strongest first.
 * - `manage`: everything in `edit`, plus changing who has access.
 * - `edit`: add, change, rotate and share secrets.
 * - `use`: copy, fill and `zv run`; can't change or share.
 * - `needs_approval`: each use waits for a manager to approve.
 * - `none`: no access. As a direct grant it blocks access a group would give.
 */
export const AccessLevel = z.enum(['manage', 'edit', 'use', 'needs_approval', 'none']);
export type AccessLevel = z.infer<typeof AccessLevel>;

/** Levels that get a standing copy of the environment key (members only). */
export const KEY_HOLDING_LEVELS = ['manage', 'edit', 'use'] as const satisfies AccessLevel[];

const RANK: Record<AccessLevel, number> = {
  none: 0,
  needs_approval: 1,
  use: 2,
  edit: 3,
  manage: 4,
};

/** True when `level` includes everything `required` allows. */
export const levelAtLeast = (level: AccessLevel, required: AccessLevel): boolean =>
  RANK[level] >= RANK[required];

/** The stronger of two levels. */
export const strongerLevel = (a: AccessLevel, b: AccessLevel): AccessLevel =>
  RANK[a] >= RANK[b] ? a : b;

export const holdsKey = (level: AccessLevel): boolean => levelAtLeast(level, 'use');

/** Who a grant is for. Groups hold no keys; their members do. */
export const PrincipalType = z.enum(['account', 'group', 'agent']);
export type PrincipalType = z.infer<typeof PrincipalType>;

export const PrincipalRef = z.object({ type: PrincipalType, id: Uuid });
export type PrincipalRef = z.infer<typeof PrincipalRef>;

/** A principal with a key of its own, which can ask for approved values: a member or an agent. */
export const KeyHolderRef = z.object({ type: z.enum(['account', 'agent']), id: Uuid });
export type KeyHolderRef = z.infer<typeof KeyHolderRef>;

export const ACCESS_LIMITS = {
  nameMax: 64,
  groupsPerOrg: 100,
  agentsPerOrg: 100,
  itemsPerRequest: 20,
  /** An approved request's released values can be fetched for this long. */
  releaseTtlSeconds: 15 * 60,
  requestTtlSeconds: 60 * 60,
} as const;

const Name = z.string().trim().min(1).max(ACCESS_LIMITS.nameMax);

// ---------------------------------------------------------------- orgs

export const CreateOrgRequest = z.object({
  name: Name,
  /** The creator's sharing public key, which environment keys are wrapped to. */
  publicKey: SharingPublicKey,
});
export type CreateOrgRequest = z.infer<typeof CreateOrgRequest>;

export const OrgSummary = z.object({
  id: OrgId,
  name: z.string(),
  role: OrgRole,
  /** `invited` until the member accepts and publishes their key. */
  status: z.enum(['invited', 'active']),
});
export type OrgSummary = z.infer<typeof OrgSummary>;

export const ListOrgsResponse = z.object({ orgs: z.array(OrgSummary) });
export type ListOrgsResponse = z.infer<typeof ListOrgsResponse>;

export const OrgMember = z.object({
  accountId: Uuid,
  email: z.email(),
  role: OrgRole,
  status: z.enum(['invited', 'active']),
  /** Null until the member accepts. Pin it and compare fingerprints out of band. */
  publicKey: SharingPublicKey.nullable(),
  groupIds: z.array(GroupId),
});
export type OrgMember = z.infer<typeof OrgMember>;

export const OrgGroup = z.object({ id: GroupId, name: z.string(), memberIds: z.array(Uuid) });
export type OrgGroup = z.infer<typeof OrgGroup>;

export const OrgAgent = z.object({
  id: AgentId,
  name: z.string(),
  /** The member who paired the agent, e.g. on their Mac. */
  ownerId: Uuid,
  publicKey: SharingPublicKey,
  createdAt: IsoDate,
});
export type OrgAgent = z.infer<typeof OrgAgent>;

export const OrgDetail = z.object({
  id: OrgId,
  name: z.string(),
  role: OrgRole,
  members: z.array(OrgMember),
  groups: z.array(OrgGroup),
  agents: z.array(OrgAgent),
});
export type OrgDetail = z.infer<typeof OrgDetail>;

export const InviteMemberRequest = z.object({
  email: z.email().max(254),
  role: OrgRole.exclude(['owner']).default('member'),
});
export type InviteMemberRequest = z.infer<typeof InviteMemberRequest>;
export type InviteMemberInput = z.input<typeof InviteMemberRequest>;

export const AcceptInviteRequest = z.object({ publicKey: SharingPublicKey });
export type AcceptInviteRequest = z.infer<typeof AcceptInviteRequest>;

export const ChangeRoleRequest = z.object({ role: OrgRole });
export type ChangeRoleRequest = z.infer<typeof ChangeRoleRequest>;

export const CreateGroupRequest = z.object({ name: Name });
export type CreateGroupRequest = z.infer<typeof CreateGroupRequest>;

export const RegisterAgentRequest = z.object({ name: Name, publicKey: SharingPublicKey });
export type RegisterAgentRequest = z.infer<typeof RegisterAgentRequest>;

// ---------------------------------------------------------------- keys

/**
 * `kid` of a project or environment key wrapped to a member's sharing key
 * (`wrap_key_to_member` in zvault-crypto). Grants with `kid` "account" are the
 * owner's own, wrapped with their account key.
 */
export const MEMBER_KEY_WRAP_KID = 'member-key-wrap' as const;
/** The `kid` of values a manager released for an approved request. */
export const ACCESS_RELEASE_KID = 'access-release' as const;

/** 32-byte key + 16-byte tag. */
const WRAPPED_KEY_CT = base64UrlOfLength(48);

/**
 * A project or environment key wrapped on a manager's device to one member.
 * Stored as that member's key grant, so the projects API serves it like any
 * other grant; the public halves come from `GET /access/projects/:id/keys/me`.
 */
export const MemberKeyWrap = z.object({
  recipientId: Uuid,
  /** The recipient key the wrapper sealed to; must match the one on file. */
  recipientPublicKey: SharingPublicKey,
  /** The wrapper's own key; must match theirs on file. Needed to unwrap. */
  wrapperPublicKey: SharingPublicKey,
  ephemeralPublicKey: SharingPublicKey,
  blob: EncryptedBlob.extend({ kid: z.literal(MEMBER_KEY_WRAP_KID), ct: WRAPPED_KEY_CT }),
});
export type MemberKeyWrap = z.infer<typeof MemberKeyWrap>;

const KeyVersion = z.number().int().min(1);
const Wraps = z.array(MemberKeyWrap).min(1).max(500);

/** Shares a project with an organization. Only the project's owner can. */
export const LinkProjectRequest = z.object({ orgId: OrgId });
export type LinkProjectRequest = z.infer<typeof LinkProjectRequest>;

/** Wraps of an environment's current key for members who don't have one yet. */
export const AddEnvironmentWrapsRequest = z.object({ keyVersion: KeyVersion, wraps: Wraps });
export type AddEnvironmentWrapsRequest = z.infer<typeof AddEnvironmentWrapsRequest>;

/** Wraps of the project key (needed to read names) for members who don't have one. */
export const AddProjectWrapsRequest = z.object({ wraps: Wraps });
export type AddProjectWrapsRequest = z.infer<typeof AddProjectWrapsRequest>;

/**
 * Moves an environment to a new key, `fromVersion + 1`. The manager's device
 * re-seals every value in the environment (`values`, one per secret that has a
 * value there, `kid` = environment id) and wraps the new key to exactly the
 * members who have standing access now, the caller included.
 */
export const RotateEnvironmentKeyRequest = z.object({
  fromVersion: KeyVersion,
  wraps: Wraps,
  values: z.array(z.object({ secretId: Uuid, encryptedValue: EncryptedBlob })).max(10_000),
});
export type RotateEnvironmentKeyRequest = z.infer<typeof RotateEnvironmentKeyRequest>;

/** A member wrap as stored, for the recipient to unwrap. */
export const StoredMemberWrap = MemberKeyWrap.extend({
  /** Environment keys only. */
  keyVersion: KeyVersion.nullable(),
  wrappedBy: Uuid,
});
export type StoredMemberWrap = z.infer<typeof StoredMemberWrap>;

/**
 * The caller's member wraps in one project. A key held through the owner's
 * own account-key grant has no entry here (the projects API serves it).
 */
export const MyProjectKeysResponse = z.object({
  projectId: ProjectId,
  projectKey: StoredMemberWrap.nullable(),
  environments: z.array(
    z.object({
      environmentId: EnvironmentId,
      keyVersion: KeyVersion,
      level: AccessLevel,
      wrap: StoredMemberWrap.nullable(),
    }),
  ),
});
export type MyProjectKeysResponse = z.infer<typeof MyProjectKeysResponse>;

/** A member with access and no grant of a key yet. */
export const PendingWrap = z.object({ accountId: Uuid, publicKey: SharingPublicKey });
export type PendingWrap = z.infer<typeof PendingWrap>;

// ---------------------------------------------------------------- grants

export const PutGrantRequest = z.object({
  principal: PrincipalRef,
  /** Agents can only be given `needs_approval` (asks each time) or `none`. */
  level: AccessLevel,
  /** When the grant lapses, e.g. a contractor's end date. Null = no end. */
  expiresAt: IsoDate.nullable().default(null),
});
export type PutGrantRequest = z.infer<typeof PutGrantRequest>;
export type PutGrantInput = z.input<typeof PutGrantRequest>;

export const Grant = z.object({
  principal: PrincipalRef,
  level: AccessLevel,
  expiresAt: IsoDate.nullable(),
  grantedBy: Uuid,
  createdAt: IsoDate,
});
export type Grant = z.infer<typeof Grant>;

export const EnvironmentAccess = z.object({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  orgId: OrgId,
  keyVersion: KeyVersion,
  /**
   * Set once someone who held the key loses access. A manager's device should
   * rotate before anything new is written to the environment.
   */
  rotationRequired: z.boolean(),
  myLevel: AccessLevel,
  grants: z.array(Grant),
  /** Only for managers: who still needs the current key wrapped to them. */
  pendingWraps: z.array(PendingWrap),
});
export type EnvironmentAccess = z.infer<typeof EnvironmentAccess>;

/**
 * The "Project access" matrix: one row per principal, one cell per
 * environment. Environment names come from the project's own (encrypted)
 * metadata.
 */
export const ProjectAccessResponse = z.object({
  projectId: ProjectId,
  orgId: OrgId,
  environments: z.array(
    z.object({ id: EnvironmentId, keyVersion: KeyVersion, rotationRequired: z.boolean() }),
  ),
  rows: z.array(
    z.object({
      principal: PrincipalRef,
      name: z.string(),
      cells: z.array(
        z.object({
          environmentId: EnvironmentId,
          level: AccessLevel,
          expiresAt: IsoDate.nullable(),
        }),
      ),
    }),
  ),
  /** Only for those who can hand out the project key: members still without it. */
  pendingProjectWraps: z.array(PendingWrap),
});
export type ProjectAccessResponse = z.infer<typeof ProjectAccessResponse>;

// ---------------------------------------------------------------- approvals

export const CreateAccessRequest = z.object({
  /** Opaque references to the secrets wanted, e.g. `zv://payments-api/dev/stripe/secret_key`. */
  items: z.array(z.string().min(1).max(512)).min(1).max(ACCESS_LIMITS.itemsPerRequest),
  /** What will use them, shown to the approver ("npm test in ~/code/zvault-api"). */
  reason: z.string().trim().min(1).max(500),
});
export type CreateAccessRequest = z.infer<typeof CreateAccessRequest>;

export const ApproveAccessRequest = z.object({
  /** The approver's key; must match theirs on file. */
  approverPublicKey: SharingPublicKey,
  ephemeralPublicKey: SharingPublicKey,
  /** The requested values, sealed to the requester with `seal_release`. */
  blob: EncryptedBlob.extend({ kid: z.literal(ACCESS_RELEASE_KID) }).refine(
    (b) => b.ct.length <= Math.ceil((64 * 1024 * 4) / 3),
    { message: 'ciphertext must be at most 65536 bytes', path: ['ct'] },
  ),
});
export type ApproveAccessRequest = z.infer<typeof ApproveAccessRequest>;

export const AccessRequestStatus = z.enum(['pending', 'approved', 'denied', 'expired']);
export type AccessRequestStatus = z.infer<typeof AccessRequestStatus>;

export const AccessRequestView = z.object({
  id: AccessRequestId,
  environmentId: EnvironmentId,
  requester: KeyHolderRef,
  requesterName: z.string(),
  /** The key the release is sealed to. */
  requesterPublicKey: SharingPublicKey,
  items: z.array(z.string()),
  reason: z.string(),
  status: AccessRequestStatus,
  createdAt: IsoDate,
  expiresAt: IsoDate,
  decidedBy: Uuid.nullable(),
  /** Present for the requester once approved, until the release expires. */
  release: ApproveAccessRequest.nullable(),
});
export type AccessRequestView = z.infer<typeof AccessRequestView>;

export const ListAccessRequestsResponse = z.object({ requests: z.array(AccessRequestView) });
export type ListAccessRequestsResponse = z.infer<typeof ListAccessRequestsResponse>;
