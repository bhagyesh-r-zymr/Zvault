import { Duration, RemovalPolicy, Stack, Validations, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import type { Construct } from 'constructs';
import type { StageConfig } from '../config.js';

export interface DataStackProps extends StackProps {
  readonly config: StageConfig;
  readonly vpc: ec2.IVpc;
  readonly dataKey: kms.IKey;
  readonly logsKey: kms.IKey;
}

export const DATABASE_NAME = 'zvault';
export const DATABASE_PORT = 5432;

/**
 * Aurora PostgreSQL Serverless v2 in isolated subnets. It holds ciphertext, SRP verifiers and
 * metadata only; encryption at rest uses the data key and every connection must use TLS.
 */
export class DataStack extends Stack {
  readonly cluster: rds.DatabaseCluster;
  readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { config, vpc, dataKey, logsKey } = props;
    const removalPolicy = config.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const clusterIdentifier = `zvault-${config.stage}`;

    const engine = rds.DatabaseClusterEngine.auroraPostgres({
      version: rds.AuroraPostgresEngineVersion.VER_17_9,
    });

    const parameterGroup = new rds.ParameterGroup(this, 'Parameters', {
      engine,
      description: 'Zvault: TLS only, audit-friendly logging',
      parameters: {
        'rds.force_ssl': '1',
        ssl_min_protocol_version: 'TLSv1.2',
        log_connections: '1',
        log_disconnections: '1',
        // Statement text can contain ciphertext and verifiers; log DDL only.
        log_statement: 'ddl',
        log_min_duration_statement: '1000',
      },
    });

    this.securityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc,
      description: 'Zvault database: ingress from the API service only',
      allowAllOutbound: false,
    });

    // Pre-create the exported log group so it is KMS-encrypted and needs no retention Lambda.
    const postgresLogs = new logs.LogGroup(this, 'PostgresLogs', {
      logGroupName: `/aws/rds/cluster/${clusterIdentifier}/postgresql`,
      encryptionKey: logsKey,
      retention: config.logRetentionDays,
      removalPolicy,
    });

    this.cluster = new rds.DatabaseCluster(this, 'Database', {
      clusterIdentifier,
      engine,
      parameterGroup,
      defaultDatabaseName: DATABASE_NAME,
      port: DATABASE_PORT,
      credentials: rds.Credentials.fromGeneratedSecret('zvault_admin', {
        secretName: `zvault/${config.stage}/database/admin`,
        encryptionKey: dataKey,
        excludeCharacters: ' %+~`#$&*()|[]{}:;<>?!\'/@"\\',
      }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.securityGroup],
      writer: rds.ClusterInstance.serverlessV2('Writer', {
        enablePerformanceInsights: true,
        performanceInsightEncryptionKey: dataKey,
        autoMinorVersionUpgrade: true,
      }),
      readers: Array.from({ length: config.database.readers }, (_, i) =>
        rds.ClusterInstance.serverlessV2(`Reader${i + 1}`, {
          scaleWithWriter: true,
          enablePerformanceInsights: true,
          performanceInsightEncryptionKey: dataKey,
          autoMinorVersionUpgrade: true,
        }),
      ),
      serverlessV2MinCapacity: config.database.minCapacityAcu,
      serverlessV2MaxCapacity: config.database.maxCapacityAcu,
      storageEncrypted: true,
      storageEncryptionKey: dataKey,
      iamAuthentication: true,
      deletionProtection: config.retainData,
      removalPolicy: config.retainData ? RemovalPolicy.SNAPSHOT : RemovalPolicy.DESTROY,
      backup: { retention: Duration.days(config.database.backupRetentionDays) },
      copyTagsToSnapshot: true,
      cloudwatchLogsExports: ['postgresql'],
      monitoringInterval: Duration.seconds(60),
    });

    this.cluster.node.addDependency(postgresLogs);

    Validations.of(this.cluster).acknowledge({
      id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole]',
      reason:
        'The enhanced monitoring role only lets RDS publish OS metrics; this is its standard policy.',
    });
    if (!config.retainData) {
      Validations.of(this.cluster).acknowledge({
        id: 'AwsSolutions::AwsSolutions-RDS10',
        reason:
          'Deletion protection is on wherever retainData is (always in prod); dev is disposable.',
      });
    }

    // Rotate the admin password monthly. The rotation Lambda reaches Secrets Manager through
    // the VPC endpoint in the app subnets.
    this.cluster.addRotationSingleUser({
      automaticallyAfter: Duration.days(30),
      vpcSubnets: { subnetGroupName: 'app' },
    });
  }

  get secret(): NonNullable<rds.DatabaseCluster['secret']> {
    const secret = this.cluster.secret;
    if (!secret) throw new Error('Database cluster has no generated secret');
    return secret;
  }
}
