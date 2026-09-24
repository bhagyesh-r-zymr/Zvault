import { Duration, RemovalPolicy, Stack, Validations, type StackProps } from 'aws-cdk-lib';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import type { StageConfig } from '../config.js';

export interface FoundationStackProps extends StackProps {
  readonly config: StageConfig;
}

/**
 * Long-lived building blocks the other stacks share: customer managed KMS keys, the VPC,
 * the access-log bucket and the account audit trail.
 */
export class FoundationStack extends Stack {
  /** Encrypts application data at rest: database storage, secrets, alarm topic. */
  readonly dataKey: kms.Key;
  /** Encrypts CloudWatch Logs log groups (API, WAF, VPC flow logs, database). */
  readonly logsKey: kms.Key;
  readonly vpc: ec2.Vpc;
  /** SSE-S3 bucket for ALB and S3 server access logs (ALB log delivery cannot use KMS). */
  readonly accessLogsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props);
    const { config } = props;
    const removalPolicy = config.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    this.dataKey = new kms.Key(this, 'DataKey', {
      alias: `alias/zvault/${config.stage}/data`,
      description: 'Zvault application data at rest (database, secrets, alarm topic)',
      enableKeyRotation: true,
      removalPolicy,
      pendingWindow: Duration.days(30),
    });

    this.logsKey = new kms.Key(this, 'LogsKey', {
      alias: `alias/zvault/${config.stage}/logs`,
      description: 'Zvault CloudWatch Logs encryption',
      enableKeyRotation: true,
      removalPolicy,
      pendingWindow: Duration.days(30),
    });
    // CloudWatch Logs may only use the key for log groups in this account and region.
    this.logsKey.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
        actions: [
          'kms:Encrypt*',
          'kms:Decrypt*',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:Describe*',
        ],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:*`,
          },
        },
      }),
    );

    this.accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      versioned: true,
      lifecycleRules: [
        {
          expiration: Duration.days(config.logRetentionDays),
          noncurrentVersionExpiration: Duration.days(7),
        },
      ],
      removalPolicy,
      autoDeleteObjects: !config.retainData,
    });

    Validations.of(this.accessLogsBucket).acknowledge({
      id: 'AwsSolutions::AwsSolutions-S1',
      reason: 'This is the access-log destination; logging it into itself would loop.',
    });

    const flowLogGroup = new logs.LogGroup(this, 'VpcFlowLogs', {
      encryptionKey: this.logsKey,
      retention: config.logRetentionDays,
      removalPolicy,
    });

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.40.0.0/16'),
      maxAzs: config.network.maxAzs,
      natGateways: config.network.natGateways,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      restrictDefaultSecurityGroup: true,
      flowLogs: {
        all: {
          destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
          trafficType: ec2.FlowLogTrafficType.ALL,
        },
      },
    });

    // Keep traffic to S3, Secrets Manager, KMS and CloudWatch Logs off the NAT gateways.
    this.vpc.addGatewayEndpoint('S3Endpoint', { service: ec2.GatewayVpcEndpointAwsService.S3 });
    const appSubnets = { subnetGroupName: 'app' };
    for (const [id, service] of [
      ['SecretsManagerEndpoint', ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER],
      ['KmsEndpoint', ec2.InterfaceVpcEndpointAwsService.KMS],
      ['LogsEndpoint', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
    ] as const) {
      const endpoint = this.vpc.addInterfaceEndpoint(id, {
        service,
        subnets: appSubnets,
        privateDnsEnabled: true,
      });
      Validations.of(endpoint).acknowledge({
        id: 'AwsSolutions::AwsSolutions-EC23',
        reason:
          'Endpoint security group allows HTTPS from the VPC CIDR only (a token nag cannot resolve).',
      });
    }

    if (config.enableCloudTrail) this.createAuditTrail(config, removalPolicy);
  }

  /** Multi-region management-event trail with digest validation, KMS encryption and a CloudWatch copy. */
  private createAuditTrail(config: StageConfig, removalPolicy: RemovalPolicy): void {
    const auditKey = new kms.Key(this, 'AuditKey', {
      alias: `alias/zvault/${config.stage}/audit`,
      description: 'Zvault CloudTrail log encryption',
      enableKeyRotation: true,
      removalPolicy,
      pendingWindow: Duration.days(30),
    });
    const trailArn = `arn:${this.partition}:cloudtrail:${this.region}:${this.account}:trail/zvault-${config.stage}`;
    auditKey.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('cloudtrail.amazonaws.com')],
        actions: ['kms:GenerateDataKey*'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'aws:SourceArn': trailArn },
          StringLike: {
            'kms:EncryptionContext:aws:cloudtrail:arn': `arn:${this.partition}:cloudtrail:*:${this.account}:trail/*`,
          },
        },
      }),
    );
    auditKey.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('cloudtrail.amazonaws.com')],
        actions: ['kms:DescribeKey'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:SourceArn': trailArn } },
      }),
    );

    const trailBucket = new s3.Bucket(this, 'AuditTrailBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: auditKey,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      versioned: true,
      serverAccessLogsBucket: this.accessLogsBucket,
      serverAccessLogsPrefix: 'cloudtrail-bucket/',
      lifecycleRules: [
        {
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
              transitionAfter: Duration.days(90),
            },
          ],
        },
      ],
      removalPolicy,
      autoDeleteObjects: !config.retainData,
    });

    new cloudtrail.Trail(this, 'AuditTrail', {
      trailName: `zvault-${config.stage}`,
      bucket: trailBucket,
      encryptionKey: auditKey,
      isMultiRegionTrail: true,
      includeGlobalServiceEvents: true,
      enableFileValidation: true,
      sendToCloudWatchLogs: true,
      cloudWatchLogGroup: new logs.LogGroup(this, 'AuditTrailLogs', {
        encryptionKey: this.logsKey,
        retention: config.logRetentionDays,
        removalPolicy,
      }),
    });
  }
}
