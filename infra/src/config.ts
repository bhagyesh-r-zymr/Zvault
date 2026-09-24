import type { App } from 'aws-cdk-lib';

export type StageName = 'dev' | 'prod';

/** Everything that differs between environments. Kept small on purpose. */
export interface StageConfig {
  readonly stage: StageName;
  /** AWS account to deploy to. Falls back to the CLI's default credentials. */
  readonly account?: string;
  readonly region: string;
  /** Public Route 53 zone the API and the email domain live in, e.g. `zvault.example.com`. */
  readonly zoneName: string;
  readonly hostedZoneId: string;
  /** API hostname is `<apiSubdomain>.<zoneName>`. */
  readonly apiSubdomain: string;
  /** Sender for verification and sharing emails; must be on `zoneName`. */
  readonly emailFromLocalPart: string;
  /** Browser origins allowed to call the API. The desktop app's native HTTP client ignores CORS. */
  readonly corsOrigins: readonly string[];
  /** Where CloudWatch alarms are emailed. Empty means no subscription. */
  readonly alarmEmail: string;
  readonly network: {
    readonly maxAzs: number;
    readonly natGateways: number;
  };
  readonly api: {
    readonly cpu: number;
    readonly memoryMiB: number;
    readonly minTasks: number;
    readonly maxTasks: number;
  };
  readonly database: {
    readonly minCapacityAcu: number;
    readonly maxCapacityAcu: number;
    readonly readers: number;
    readonly backupRetentionDays: number;
  };
  /** Protects stateful resources (database, keys, buckets) from deletion. Always on in prod. */
  readonly retainData: boolean;
  /** Turn off if the account already has an organization-wide trail. */
  readonly enableCloudTrail: boolean;
  readonly logRetentionDays: number;
}

const DEFAULTS: Record<
  StageName,
  Omit<StageConfig, 'stage' | 'region' | 'zoneName' | 'hostedZoneId'>
> = {
  dev: {
    apiSubdomain: 'api',
    emailFromLocalPart: 'no-reply',
    corsOrigins: ['tauri://localhost', 'http://tauri.localhost'],
    alarmEmail: '',
    network: { maxAzs: 2, natGateways: 1 },
    api: { cpu: 512, memoryMiB: 1024, minTasks: 1, maxTasks: 2 },
    database: { minCapacityAcu: 0.5, maxCapacityAcu: 2, readers: 0, backupRetentionDays: 7 },
    retainData: false,
    enableCloudTrail: true,
    logRetentionDays: 30,
  },
  prod: {
    apiSubdomain: 'api',
    emailFromLocalPart: 'no-reply',
    corsOrigins: ['tauri://localhost', 'http://tauri.localhost'],
    alarmEmail: '',
    network: { maxAzs: 3, natGateways: 3 },
    api: { cpu: 1024, memoryMiB: 2048, minTasks: 2, maxTasks: 10 },
    database: { minCapacityAcu: 1, maxCapacityAcu: 16, readers: 1, backupRetentionDays: 35 },
    retainData: true,
    enableCloudTrail: true,
    logRetentionDays: 365,
  },
};

const PLACEHOLDER_ZONE_ID = 'Z00000000000000000000';

/** Stage config with defaults applied, for tests and for {@link loadStageConfig}. */
export function buildStageConfig(
  stage: StageName,
  overrides: Partial<StageConfig> & Pick<StageConfig, 'region' | 'zoneName' | 'hostedZoneId'>,
): StageConfig {
  const config: StageConfig = { ...DEFAULTS[stage], stage, ...overrides };
  // Never let a prod config opt out of data retention.
  return stage === 'prod' ? { ...config, retainData: true } : config;
}

/**
 * Reads `-c zvault:stage=<dev|prod>` and the matching `zvault:<stage>` block from cdk.json.
 * Refuses the placeholder hosted zone unless `-c zvault:allowPlaceholders=true` (CI synth only).
 */
export function loadStageConfig(app: App): StageConfig {
  const stage = (app.node.tryGetContext('zvault:stage') as string | undefined) ?? 'dev';
  if (stage !== 'dev' && stage !== 'prod') {
    throw new Error(`zvault:stage must be "dev" or "prod", got "${stage}"`);
  }
  const raw = app.node.tryGetContext(`zvault:${stage}`) as Record<string, unknown> | undefined;
  if (!raw) throw new Error(`Missing "zvault:${stage}" context in cdk.json`);

  const str = (key: string): string | undefined => {
    const value = raw[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  const region = str('region');
  const zoneName = str('zoneName');
  const hostedZoneId = str('hostedZoneId');
  if (!region || !zoneName || !hostedZoneId) {
    throw new Error(`zvault:${stage} needs region, zoneName and hostedZoneId`);
  }
  const allowPlaceholders = String(app.node.tryGetContext('zvault:allowPlaceholders')) === 'true';
  if (hostedZoneId === PLACEHOLDER_ZONE_ID && !allowPlaceholders) {
    throw new Error(
      `zvault:${stage} still uses the placeholder hosted zone. Set zoneName and hostedZoneId in infra/cdk.json.`,
    );
  }

  const account = str('account');
  const alarmEmail = str('alarmEmail');
  return buildStageConfig(stage, {
    region,
    zoneName,
    hostedZoneId,
    ...(account ? { account } : {}),
    ...(alarmEmail ? { alarmEmail } : {}),
  });
}
