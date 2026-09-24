import { useSyncExternalStore } from 'react';

/**
 * UI model for project secrets: Project › Environment › (one level of)
 * Folder, plus free-form tags. One secret holds a value per environment.
 *
 * The server side (projects, per-environment keys, team roles) is being built
 * separately. Until its contracts land in @zvault/shared, the app runs these
 * screens on the in-memory preview store below, which holds sample data only
 * and never touches real secrets.
 */

export type EnvColor = 'green' | 'amber' | 'red' | 'violet' | 'blue';

export const ENV_COLORS: Record<EnvColor, string> = {
  green: '#45d6a0',
  amber: '#f2b64c',
  red: '#ff7a7a',
  violet: '#d9a3f5',
  blue: '#8ea0ff',
};

export interface Environment {
  id: string;
  name: string;
  short: string;
  color: EnvColor;
  /** Only people with Manage access can read it without approval. */
  restricted?: boolean;
}

export interface Project {
  id: string;
  /** Used in `zv://<slug>/<env>/<item>/<field>` references. */
  slug: string;
  name: string;
  tile: { bg: string; fg: string };
  environments: Environment[];
}

export type SecretKind = 'database' | 'apiKey' | 'login' | 'email' | 'sshKey' | 'note';

export interface SecretField {
  label: string;
  value: string;
  secret?: boolean;
}

export interface ProjectSecret {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  envVars: string[];
  kind: SecretKind;
  folder?: string;
  tags: string[];
  /** Fields per environment id. A missing environment means "not set". */
  values: Record<string, SecretField[] | undefined>;
}

export type AccessLevel = 'manage' | 'edit' | 'use' | 'approval' | 'none';

export const ACCESS_LABELS: Record<AccessLevel, string> = {
  manage: 'Manage',
  edit: 'Edit',
  use: 'Use',
  approval: 'Needs approval',
  none: 'No access',
};

export interface AccessEntry {
  id: string;
  name: string;
  kind: 'group' | 'person' | 'agent';
  detail: string;
  levels: Record<string, AccessLevel>;
  /** Extra words shown after the level, e.g. "asks each time". */
  note?: string;
}

const STANDARD_ENVS: Environment[] = [
  { id: 'dev', name: 'Development', short: 'Dev', color: 'green' },
  { id: 'staging', name: 'Staging', short: 'Staging', color: 'amber' },
  { id: 'prod', name: 'Production', short: 'Prod', color: 'red', restricted: true },
];

const PROJECTS: Project[] = [
  {
    id: 'zvault',
    slug: 'zvault',
    name: 'Zvault',
    tile: { bg: '#4c5be8', fg: '#fff' },
    environments: [
      ...STANDARD_ENVS,
      { id: 'qa', name: 'QA sandbox', short: 'QA', color: 'violet' },
    ],
  },
  {
    id: 'payments',
    slug: 'payments-api',
    name: 'Payments API',
    tile: { bg: '#1e3b33', fg: '#7fe6be' },
    environments: STANDARD_ENVS,
  },
  {
    id: 'portal',
    slug: 'customer-portal',
    name: 'Customer portal',
    tile: { bg: '#3a2a14', fg: '#f2b64c' },
    environments: STANDARD_ENVS,
  },
  {
    id: 'mobile',
    slug: 'mobile-app',
    name: 'Mobile app',
    tile: { bg: '#33203a', fg: '#d9a3f5' },
    environments: STANDARD_ENVS,
  },
];

const f = (label: string, value: string, secret = false): SecretField => ({
  label,
  value,
  ...(secret && { secret }),
});

// Sample values only: nothing here is a real credential.
const SECRETS: ProjectSecret[] = [
  {
    id: 's1',
    projectId: 'zvault',
    name: 'Postgres',
    slug: 'postgres',
    envVars: ['DATABASE_URL'],
    kind: 'database',
    folder: 'api',
    tags: ['database', 'rds'],
    values: {
      dev: [
        f('host', 'localhost:5432'),
        f('username', 'zvault'),
        f('password', 'dev-only-Pa55!', true),
      ],
      staging: [
        f('host', 'zvault-stg.cluster-preview.ap-south-1.rds.amazonaws.com'),
        f('username', 'zvault_app'),
        f('password', 'tQ7#vm42Lx!Rp9Kw_eH3', true),
      ],
      prod: [
        f('host', 'zvault-prod.cluster-preview.ap-south-1.rds.amazonaws.com'),
        f('username', 'zvault_app'),
        f('password', 'preview-Qz8$Lr2!Vn7@kD4', true),
      ],
    },
  },
  {
    id: 's2',
    projectId: 'zvault',
    name: 'JWT signing secret',
    slug: 'jwt',
    envVars: ['JWT_SECRET'],
    kind: 'apiKey',
    folder: 'api',
    tags: ['auth'],
    values: {
      dev: [f('secret', 'dev-jwt-not-secret', true)],
      staging: [f('secret', 'b8F#2kQ9!mZ4xW7@pL', true)],
      prod: [f('secret', 'preview-9Hq$4Tz!8Wm2', true)],
    },
  },
  {
    id: 's3',
    projectId: 'zvault',
    name: 'Amazon SES SMTP',
    slug: 'ses',
    envVars: ['SMTP_USER', 'SMTP_PASS'],
    kind: 'email',
    folder: 'api',
    tags: ['email', 'aws'],
    values: {
      staging: [f('username', 'AKIA…PREVIEW-STG'), f('password', 'preview/Smtp+Pass=42', true)],
      prod: [f('username', 'AKIA…PREVIEW-PRD'), f('password', 'preview/Prod+Smtp=77', true)],
    },
  },
  {
    id: 's4',
    projectId: 'zvault',
    name: 'GitHub deploy key',
    slug: 'github-deploy',
    envVars: ['DEPLOY_KEY'],
    kind: 'sshKey',
    folder: 'infra',
    tags: ['ci'],
    values: {
      dev: [f('key', 'ssh-ed25519 AAAAC3Nz…preview dev@zvault', true)],
      staging: [f('key', 'ssh-ed25519 AAAAC3Nz…preview stg@zvault', true)],
      prod: [f('key', 'ssh-ed25519 AAAAC3Nz…preview prod@zvault', true)],
    },
  },
  {
    id: 's5',
    projectId: 'zvault',
    name: 'AWS account (ap-south-1)',
    slug: 'aws',
    envVars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
    kind: 'login',
    folder: 'infra',
    tags: ['aws'],
    values: {
      staging: [
        f('access key id', 'AKIA…PREVIEW-STG'),
        f('secret access key', 'preview+Aws/Secret=Stg', true),
      ],
      prod: [
        f('access key id', 'AKIA…PREVIEW-PRD'),
        f('secret access key', 'preview+Aws/Secret=Prd', true),
      ],
    },
  },
  {
    id: 's6',
    projectId: 'zvault',
    name: 'Release notes signing',
    slug: 'release-notes',
    envVars: [],
    kind: 'note',
    tags: ['release'],
    values: { prod: [f('note', 'Signing identity lives in the Apple developer account.')] },
  },
  {
    id: 'p1',
    projectId: 'payments',
    name: 'Stripe secret key',
    slug: 'stripe',
    envVars: ['STRIPE_SECRET_KEY'],
    kind: 'apiKey',
    folder: 'billing',
    tags: ['payments', 'third-party'],
    values: {
      dev: [f('secret_key', 'sk_test_…preview-dev', true)],
      staging: [f('secret_key', 'sk_test_…preview-stg', true)],
      prod: [f('secret_key', 'sk_live_…preview-prod', true)],
    },
  },
  {
    id: 'p2',
    projectId: 'payments',
    name: 'Webhook signing secret',
    slug: 'stripe-webhook',
    envVars: ['STRIPE_WEBHOOK_SECRET'],
    kind: 'apiKey',
    folder: 'billing',
    tags: ['payments'],
    values: {
      dev: [f('secret', 'whsec_preview_dev', true)],
      staging: [f('secret', 'whsec_preview_staging', true)],
    },
  },
  {
    id: 'p3',
    projectId: 'payments',
    name: 'Ledger database',
    slug: 'ledger-db',
    envVars: ['LEDGER_DATABASE_URL'],
    kind: 'database',
    tags: ['database'],
    values: {
      dev: [f('url', 'postgres://ledger:preview@localhost/ledger', true)],
      staging: [f('url', 'postgres://ledger:preview@ledger-stg/ledger', true)],
      prod: [f('url', 'postgres://ledger:preview@ledger-prod/ledger', true)],
    },
  },
  {
    id: 'c1',
    projectId: 'portal',
    name: 'Auth0 client secret',
    slug: 'auth0',
    envVars: ['AUTH0_CLIENT_SECRET'],
    kind: 'apiKey',
    tags: ['auth', 'third-party'],
    values: {
      dev: [f('client_secret', 'preview-auth0-dev', true)],
      staging: [f('client_secret', 'preview-auth0-stg', true)],
      prod: [f('client_secret', 'preview-auth0-prod', true)],
    },
  },
  {
    id: 'm1',
    projectId: 'mobile',
    name: 'App Store Connect key',
    slug: 'asc-key',
    envVars: ['ASC_KEY_ID', 'ASC_PRIVATE_KEY'],
    kind: 'apiKey',
    tags: ['release', 'apple'],
    values: {
      prod: [
        f('key id', 'PREVIEW42'),
        f('private key', '-----BEGIN PRIVATE KEY----- preview', true),
      ],
    },
  },
  {
    id: 'm2',
    projectId: 'mobile',
    name: 'Firebase config',
    slug: 'firebase',
    envVars: ['FIREBASE_API_KEY'],
    kind: 'apiKey',
    tags: ['push'],
    values: {
      dev: [f('api key', 'AIzaPreviewDevKey', true)],
      staging: [f('api key', 'AIzaPreviewStgKey', true)],
      prod: [f('api key', 'AIzaPreviewPrdKey', true)],
    },
  },
];

const ACCESS: Record<string, AccessEntry[]> = {
  zvault: [
    {
      id: 'managers',
      name: 'Managers',
      kind: 'group',
      detail: 'Group · 2 people',
      levels: { dev: 'manage', staging: 'manage', prod: 'manage', qa: 'manage' },
    },
    {
      id: 'backend',
      name: 'Backend team',
      kind: 'group',
      detail: 'Group · 5 teammates',
      levels: { dev: 'edit', staging: 'edit', prod: 'approval', qa: 'edit' },
    },
    {
      id: 'qa',
      name: 'QA',
      kind: 'group',
      detail: 'Group · 3 teammates',
      levels: { dev: 'use', staging: 'use', prod: 'none', qa: 'edit' },
    },
    {
      id: 'riya',
      name: 'Riya (contractor)',
      kind: 'person',
      detail: 'This project only · until Oct 31',
      levels: { dev: 'use', staging: 'none', prod: 'none', qa: 'none' },
    },
    {
      id: 'claude-code',
      name: 'Claude Code',
      kind: 'agent',
      detail: 'Agent on this Mac',
      note: 'asks each time',
      levels: { dev: 'use', staging: 'use', prod: 'none', qa: 'none' },
    },
  ],
};

export function accessFor(projectId: string): AccessEntry[] {
  return (
    ACCESS[projectId] ?? [
      {
        id: 'me',
        name: 'You',
        kind: 'person',
        detail: 'Owner',
        levels: Object.fromEntries(
          (PROJECTS.find((p) => p.id === projectId)?.environments ?? []).map((e) => [
            e.id,
            'manage' as const,
          ]),
        ),
      },
    ]
  );
}

type Listener = () => void;

/** In-memory preview store. Changes last until the app quits. */
class PreviewProjects {
  private projects = PROJECTS;
  private secrets = SECRETS;
  private readonly listeners = new Set<Listener>();
  private snapshot = { projects: this.projects, secrets: this.secrets };

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  get = () => this.snapshot;

  addSecret(secret: Omit<ProjectSecret, 'id'>): ProjectSecret {
    const created = { ...secret, id: crypto.randomUUID() };
    this.secrets = [...this.secrets, created];
    this.emit();
    return created;
  }

  addEnvironment(projectId: string, name: string): Environment {
    const env: Environment = {
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || crypto.randomUUID(),
      name,
      short: name.length > 8 ? name.split(/\s+/)[0]! : name,
      color: 'blue',
    };
    this.projects = this.projects.map((p) =>
      p.id === projectId ? { ...p, environments: [...p.environments, env] } : p,
    );
    this.emit();
    return env;
  }

  private emit() {
    this.snapshot = { projects: this.projects, secrets: this.secrets };
    for (const l of this.listeners) l();
  }
}

export const previewProjects = new PreviewProjects();

export function useProjects() {
  return useSyncExternalStore(previewProjects.subscribe, previewProjects.get);
}

export function secretRef(
  project: Project,
  env: Environment,
  secret: ProjectSecret,
  field: string,
) {
  return `zv://${project.slug}/${env.id}/${secret.slug}/${field.replace(/\s+/g, '_')}`;
}
