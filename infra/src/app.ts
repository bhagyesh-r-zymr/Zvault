import { Tags, Validations, type App } from 'aws-cdk-lib';
import type * as ecs from 'aws-cdk-lib/aws-ecs';
import { AwsSolutionsChecks } from 'cdk-nag';
import type { StageConfig } from './config.js';
import { ApiStack } from './stacks/api-stack.js';
import { DataStack } from './stacks/data-stack.js';
import { EmailStack } from './stacks/email-stack.js';
import { FoundationStack } from './stacks/foundation-stack.js';

export interface ZvaultStacks {
  readonly foundation: FoundationStack;
  readonly data: DataStack;
  readonly email: EmailStack;
  readonly api: ApiStack;
}

export interface AddZvaultStacksOptions {
  /** Replaces the Docker build of the API image (tests use a registry image). */
  readonly containerImage?: ecs.ContainerImage;
}

/**
 * Adds the four stacks for one stage. Stateful resources (keys, VPC, database) sit in their
 * own stacks so the API stack can be torn down and redeployed freely.
 */
export function addZvaultStacks(
  app: App,
  config: StageConfig,
  options: AddZvaultStacksOptions = {},
): ZvaultStacks {
  const env = { region: config.region, ...(config.account ? { account: config.account } : {}) };
  const prefix = `Zvault-${config.stage}`;

  const foundation = new FoundationStack(app, `${prefix}-Foundation`, { env, config });
  const data = new DataStack(app, `${prefix}-Data`, {
    env,
    config,
    vpc: foundation.vpc,
    dataKey: foundation.dataKey,
    logsKey: foundation.logsKey,
  });
  const email = new EmailStack(app, `${prefix}-Email`, { env, config });
  const api = new ApiStack(app, `${prefix}-Api`, {
    env,
    config,
    vpc: foundation.vpc,
    dataKey: foundation.dataKey,
    logsKey: foundation.logsKey,
    accessLogsBucket: foundation.accessLogsBucket,
    database: data.cluster,
    databaseSecret: data.secret,
    databaseSecurityGroup: data.securityGroup,
    emailIdentity: email.identity,
    emailConfigurationSet: email.configurationSet,
    emailFromAddress: email.fromAddress,
    ...(options.containerImage ? { containerImage: options.containerImage } : {}),
  });

  for (const stack of [foundation, data, email, api]) {
    Tags.of(stack).add('project', 'zvault');
    Tags.of(stack).add('stage', config.stage);
  }
  // Fails synth on any AWS Solutions finding that is not acknowledged with a reason.
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));

  return { foundation, data, email, api };
}
