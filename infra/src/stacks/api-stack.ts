import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Validations,
  type StackProps,
} from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type * as ses from 'aws-cdk-lib/aws-ses';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';
import type { StageConfig } from '../config.js';
import { importHostedZone } from '../hosted-zone.js';
import { DATABASE_NAME, DATABASE_PORT } from './data-stack.js';
import { ApiWaf } from '../constructs/api-waf.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CONTAINER_PORT = 3000;
const HEALTH_PATH = '/v1/health';

export interface ApiStackProps extends StackProps {
  readonly config: StageConfig;
  readonly vpc: ec2.IVpc;
  readonly dataKey: kms.IKey;
  readonly logsKey: kms.IKey;
  readonly accessLogsBucket: s3.IBucket;
  readonly database: rds.IDatabaseCluster;
  readonly databaseSecret: secretsmanager.ISecret;
  readonly databaseSecurityGroup: ec2.ISecurityGroup;
  readonly emailIdentity: ses.IEmailIdentity;
  readonly emailConfigurationSet: ses.IConfigurationSet;
  readonly emailFromAddress: string;
  /** Build the container image from the repo. Tests turn this off to skip Docker. */
  readonly containerImage?: ecs.ContainerImage;
}

/**
 * The NestJS API on ECS Fargate (ARM64) in private subnets, behind an internet-facing ALB that
 * terminates TLS 1.2+ with post-quantum key exchange and is fronted by AWS WAF.
 */
export class ApiStack extends Stack {
  readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { config, vpc } = props;
    // Reference shared keys and secrets by ARN. Grants then land in this stack's IAM policies
    // (the key policies already delegate to account IAM) instead of editing the owning stacks,
    // which would make them depend on this one.
    const dataKey = kms.Key.fromKeyArn(this, 'DataKey', props.dataKey.keyArn);
    const logsKey = kms.Key.fromKeyArn(this, 'LogsKey', props.logsKey.keyArn);
    const databaseSecret = secretsmanager.Secret.fromSecretAttributes(this, 'DatabaseSecret', {
      secretCompleteArn: props.databaseSecret.secretArn,
      encryptionKey: dataKey,
    });
    const removalPolicy = config.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const zone = importHostedZone(this, config);
    const apiDomain = `${config.apiSubdomain}.${config.zoneName}`;
    this.apiUrl = `https://${apiDomain}`;

    // --- Secrets ------------------------------------------------------------------------------
    // Server-side signing material for sessions and email-verification tokens. Never user keys.
    const appSecret = new secretsmanager.Secret(this, 'AppSecret', {
      secretName: `zvault/${config.stage}/api/app`,
      description: 'Zvault API server-side signing keys',
      encryptionKey: dataKey,
      generateSecretString: {
        secretStringTemplate: '{}',
        generateStringKey: 'SERVER_SECRET',
        passwordLength: 64,
        excludePunctuation: true,
      },
      removalPolicy,
    });

    Validations.of(appSecret).acknowledge({
      id: 'AwsSolutions::AwsSolutions-SMG4',
      reason:
        'Rotating the signing key signs every user out; rotate by hand with a key-overlap window.',
    });

    // Root key sealing TOTP secrets at rest: 43 base64url characters (32 bytes), as the API
    // expects. Never rotate it in place: existing 2FA enrollments would no longer decrypt.
    const twoFactorKey = new secretsmanager.Secret(this, 'TwoFactorKey', {
      secretName: `zvault/${config.stage}/api/two-factor`,
      description: 'Zvault API key sealing TOTP secrets at rest',
      encryptionKey: dataKey,
      generateSecretString: {
        secretStringTemplate: '{}',
        generateStringKey: 'TWO_FACTOR_ENCRYPTION_KEY',
        passwordLength: 43,
        excludePunctuation: true,
        includeSpace: false,
      },
      removalPolicy,
    });
    Validations.of(twoFactorKey).acknowledge({
      id: 'AwsSolutions::AwsSolutions-SMG4',
      reason:
        'Rotating this key would make stored TOTP secrets unreadable; it needs a re-seal migration.',
    });

    // --- Compute ------------------------------------------------------------------------------
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
    });

    const logGroup = new logs.LogGroup(this, 'ApiLogs', {
      logGroupName: `/zvault/${config.stage}/api`,
      encryptionKey: logsKey,
      retention: config.logRetentionDays,
      removalPolicy,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      cpu: config.api.cpu,
      memoryLimitMiB: config.api.memoryMiB,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const image =
      props.containerImage ??
      ecs.ContainerImage.fromAsset(REPO_ROOT, {
        file: 'infra/docker/api.Dockerfile',
        platform: ecrAssets.Platform.LINUX_ARM64,
        exclude: [
          '**/node_modules',
          '**/dist',
          '**/.turbo',
          '**/cdk.out',
          'target',
          '.git',
          '.env',
          '**/.env',
          // Only workspace manifests are needed from packages the API does not use; keeping
          // other sources out means their edits do not rebuild the image.
          'apps/desktop/src',
          'apps/desktop/src-tauri',
          'crates',
          'infra/bin',
          'infra/src',
          'infra/test',
        ],
      });

    const container = taskDefinition.addContainer('api', {
      image,
      readonlyRootFilesystem: true,
      user: '65532', // distroless "nonroot"
      portMappings: [{ containerPort: CONTAINER_PORT }],
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'api' }),
      environment: {
        NODE_ENV: 'production',
        PORT: String(CONTAINER_PORT),
        CORS_ORIGINS: config.corsOrigins.join(','),
        DATABASE_HOST: props.database.clusterEndpoint.hostname,
        DATABASE_PORT: String(DATABASE_PORT),
        DATABASE_NAME,
        DATABASE_SSL: 'true',
        MAIL_TRANSPORT: 'ses',
        SES_FROM_ADDRESS: props.emailFromAddress,
        SES_CONFIGURATION_SET: props.emailConfigurationSet.configurationSetName,
        APP_PUBLIC_URL: this.apiUrl,
        // One ALB in front of the tasks, so rate limits key on the real client IP.
        TRUST_PROXY_HOPS: '1',
        // The API reads the password from this secret on connect, so the monthly rotation
        // takes effect without restarting tasks.
        DATABASE_CREDENTIALS_ARN: databaseSecret.secretArn,
      },
      secrets: {
        DATABASE_USER: ecs.Secret.fromSecretsManager(databaseSecret, 'username'),
        SERVER_SECRET: ecs.Secret.fromSecretsManager(appSecret, 'SERVER_SECRET'),
        TWO_FACTOR_ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(
          twoFactorKey,
          'TWO_FACTOR_ENCRYPTION_KEY',
        ),
      },
    });
    databaseSecret.grantRead(taskDefinition.taskRole);
    // Node writes nothing to disk except temp files; give it a scratch volume.
    taskDefinition.addVolume({ name: 'tmp' });
    container.addMountPoints({ sourceVolume: 'tmp', containerPath: '/tmp', readOnly: false });

    // Least privilege: send mail only from the Zvault address, through the Zvault identity.
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: [
          props.emailIdentity.emailIdentityArn,
          this.formatArn({
            service: 'ses',
            resource: 'configuration-set',
            resourceName: props.emailConfigurationSet.configurationSetName,
          }),
        ],
        conditions: { StringEquals: { 'ses:FromAddress': props.emailFromAddress } },
      }),
    );

    const serviceSecurityGroup = new ec2.SecurityGroup(this, 'ServiceSecurityGroup', {
      vpc,
      description: 'Zvault API tasks',
      allowAllOutbound: false,
    });
    // HTTPS to SES, ECR and other AWS APIs (endpoints or NAT), and PostgreSQL to the database.
    serviceSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'AWS APIs over HTTPS',
    );
    serviceSecurityGroup.addEgressRule(
      ec2.Peer.securityGroupId(props.databaseSecurityGroup.securityGroupId),
      ec2.Port.tcp(DATABASE_PORT),
      'Database',
    );

    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      desiredCount: config.api.minTasks,
      vpcSubnets: { subnetGroupName: 'app' },
      securityGroups: [serviceSecurityGroup],
      assignPublicIp: false,
      enableExecuteCommand: false,
      circuitBreaker: { enable: true, rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

    // Database ingress from these tasks only.
    // Declared here rather than on the database security group so the data stack never
    // depends on this one.
    new ec2.CfnSecurityGroupIngress(this, 'DatabaseIngressFromApi', {
      groupId: props.databaseSecurityGroup.securityGroupId,
      sourceSecurityGroupId: serviceSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: DATABASE_PORT,
      toPort: DATABASE_PORT,
      description: 'Zvault API tasks',
    });

    const scaling = service.autoScaleTaskCount({
      minCapacity: config.api.minTasks,
      maxCapacity: config.api.maxTasks,
    });
    scaling.scaleOnCpuUtilization('Cpu', { targetUtilizationPercent: 60 });

    // --- Load balancer ------------------------------------------------------------------------
    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: apiDomain,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      description: 'Zvault API load balancer: HTTPS from the internet',
      allowAllOutbound: false,
    });
    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');
    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Redirect to HTTPS');

    const alb = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: albSecurityGroup,
      dropInvalidHeaderFields: true,
      deletionProtection: config.retainData,
      desyncMitigationMode: elbv2.DesyncMitigationMode.STRICTEST,
    });
    alb.logAccessLogs(props.accessLogsBucket, `alb/${config.stage}`);

    alb.addRedirect({
      sourceProtocol: elbv2.ApplicationProtocol.HTTP,
      sourcePort: 80,
      targetProtocol: elbv2.ApplicationProtocol.HTTPS,
      targetPort: 443,
    });

    const httpsListener = alb.addListener('Https', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
      sslPolicy: elbv2.SslPolicy.TLS13_12_RES_PQ,
      open: false,
    });
    const targetGroup = httpsListener.addTargets('Api', {
      port: CONTAINER_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      deregistrationDelay: Duration.seconds(30),
      healthCheck: {
        path: HEALTH_PATH,
        healthyHttpCodes: '200',
        interval: Duration.seconds(15),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });
    scaling.scaleOnRequestCount('Requests', {
      requestsPerTarget: 1000,
      targetGroup,
    });

    new ApiWaf(this, 'Waf', {
      stage: config.stage,
      resourceArn: alb.loadBalancerArn,
      logsKey,
      logRetentionDays: config.logRetentionDays,
      removalPolicy,
    });

    new route53.ARecord(this, 'ApiAlias', {
      zone,
      recordName: apiDomain,
      target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(alb)),
    });

    // --- Alarms -------------------------------------------------------------------------------
    const alarmKey = new kms.Key(this, 'AlarmTopicKey', {
      alias: `alias/zvault/${config.stage}/alarms`,
      description: 'Zvault alarm topic encryption',
      enableKeyRotation: true,
      removalPolicy,
    });
    alarmKey.grant(
      new iam.ServicePrincipal('cloudwatch.amazonaws.com'),
      'kms:Decrypt',
      'kms:GenerateDataKey*',
    );
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `zvault-${config.stage}-alarms`,
      masterKey: alarmKey,
      enforceSSL: true,
    });
    if (config.alarmEmail) {
      alarmTopic.addSubscription(new subscriptions.EmailSubscription(config.alarmEmail));
    }
    const alarmAction = new cwActions.SnsAction(alarmTopic);
    const alarms: cloudwatch.Alarm[] = [
      alb.metrics
        .httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { period: Duration.minutes(5) })
        .createAlarm(this, 'Alb5xx', {
          alarmDescription: 'Load balancer is returning 5xx errors',
          threshold: 10,
          evaluationPeriods: 1,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        }),
      targetGroup.metrics
        .httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: Duration.minutes(5) })
        .createAlarm(this, 'Api5xx', {
          alarmDescription: 'API is returning 5xx errors',
          threshold: 10,
          evaluationPeriods: 1,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        }),
      targetGroup.metrics
        .unhealthyHostCount({ period: Duration.minutes(1) })
        .createAlarm(this, 'UnhealthyTasks', {
          alarmDescription: 'API tasks are failing health checks',
          threshold: 1,
          evaluationPeriods: 3,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        }),
      props.database
        .metricCPUUtilization({ period: Duration.minutes(5) })
        .createAlarm(this, 'DatabaseCpu', {
          alarmDescription: 'Database CPU is high',
          threshold: 80,
          evaluationPeriods: 3,
        }),
    ];
    for (const alarm of alarms) alarm.addAlarmAction(alarmAction);

    Validations.of(taskDefinition).acknowledge(
      {
        id: 'AwsSolutions::AwsSolutions-ECS2',
        reason: 'Environment variables carry non-secret config; secrets come from Secrets Manager.',
      },
      {
        id: 'AwsSolutions-IAM5[Resource::*]',
        reason: 'ecr:GetAuthorizationToken does not support resource-level permissions.',
      },
    );
    Validations.of(albSecurityGroup).acknowledge({
      id: 'AwsSolutions::AwsSolutions-EC23',
      reason:
        'Public API: the load balancer takes HTTPS (and an HTTP redirect) from anywhere, behind WAF.',
    });

    new CfnOutput(this, 'ApiUrl', { value: this.apiUrl });
    // Migrations run as a one-off task from the same image (the API's drizzle folder ships in it).
    const appSubnetIds = vpc.selectSubnets({ subnetGroupName: 'app' }).subnetIds.join(',');
    new CfnOutput(this, 'MigrateCommand', {
      description: 'Runs database migrations as a one-off Fargate task',
      value:
        `aws ecs run-task --cluster ${cluster.clusterName} --task-definition ${taskDefinition.family}` +
        ` --launch-type FARGATE --network-configuration "awsvpcConfiguration={subnets=[${appSubnetIds}],` +
        `securityGroups=[${serviceSecurityGroup.securityGroupId}],assignPublicIp=DISABLED}"` +
        ` --overrides '{"containerOverrides":[{"name":"api","command":["dist/db/migrate.js"]}]}'`,
    });
    new CfnOutput(this, 'AlarmTopicArn', { value: alarmTopic.topicArn });
  }
}
