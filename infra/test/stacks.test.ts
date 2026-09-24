import { readFileSync } from 'node:fs';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { beforeAll, describe, expect, it } from 'vitest';
import { addZvaultStacks } from '../src/app.js';
import { buildStageConfig, loadStageConfig, type StageName } from '../src/config.js';

// Use the same feature flags as `cdk synth`.
const cdkJson = JSON.parse(readFileSync(new URL('../cdk.json', import.meta.url), 'utf8')) as {
  context: Record<string, unknown>;
};

function synth(stage: StageName) {
  const app = new App({ context: cdkJson.context });
  const stacks = addZvaultStacks(
    app,
    buildStageConfig(stage, {
      account: '123456789012',
      region: 'us-east-1',
      zoneName: 'zvault.test',
      hostedZoneId: 'Z0123456789ABCDEFGHIJ',
      alarmEmail: 'ops@zvault.test',
    }),
    // Skip the Docker build context in unit tests.
    { containerImage: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/node:22') },
  );
  // Throws if cdk-nag reports an unacknowledged finding.
  app.synth();
  return {
    foundation: Template.fromStack(stacks.foundation),
    data: Template.fromStack(stacks.data),
    email: Template.fromStack(stacks.email),
    api: Template.fromStack(stacks.api),
  };
}

describe.each(['dev', 'prod'] as const)('%s stage', (stage) => {
  let t: ReturnType<typeof synth>;
  beforeAll(() => {
    t = synth(stage);
  });

  it('keeps the database encrypted, private and TLS-only', () => {
    t.data.hasResourceProperties('AWS::RDS::DBCluster', {
      Engine: 'aurora-postgresql',
      StorageEncrypted: true,
      KmsKeyId: Match.anyValue(),
      EnableIAMDatabaseAuthentication: true,
      DeletionProtection: stage === 'prod',
      EnableCloudwatchLogsExports: ['postgresql'],
    });
    t.data.hasResourceProperties('AWS::RDS::DBClusterParameterGroup', {
      Parameters: Match.objectLike({ 'rds.force_ssl': '1', ssl_min_protocol_version: 'TLSv1.2' }),
    });
    t.data.hasResourceProperties('AWS::RDS::DBInstance', { PubliclyAccessible: false });
    t.data.hasResourceProperties('AWS::SecretsManager::RotationSchedule', Match.anyValue());
  });

  it('only lets the API tasks reach the database port', () => {
    t.api.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 5432,
      ToPort: 5432,
      SourceSecurityGroupId: Match.anyValue(),
    });
    t.api.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Zvault API tasks',
      SecurityGroupEgress: [
        Match.objectLike({ CidrIp: '0.0.0.0/0', FromPort: 443, ToPort: 443 }),
        Match.objectLike({ FromPort: 5432, ToPort: 5432 }),
      ],
    });
    t.data.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: Match.stringLikeRegexp('ingress from the API service only'),
      SecurityGroupIngress: Match.absent(),
    });
  });

  it('terminates TLS 1.2+ with post-quantum key exchange and redirects HTTP', () => {
    t.api.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Protocol: 'HTTPS',
      SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-Res-PQ-2025-09',
    });
    t.api.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Protocol: 'HTTP',
      DefaultActions: [Match.objectLike({ Type: 'redirect' })],
    });
    t.api.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      LoadBalancerAttributes: Match.arrayWith([
        { Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' },
        { Key: 'access_logs.s3.enabled', Value: 'true' },
      ]),
    });
  });

  it('puts WAF in front of the load balancer with auth throttling', () => {
    t.api.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'REGIONAL',
      Rules: Match.arrayWith([
        Match.objectLike({ Name: 'RateLimitAuth' }),
        Match.objectLike({ Name: 'RateLimitAll' }),
        Match.objectLike({ Name: 'AWSManagedRulesCommonRuleSet' }),
      ]),
    });
    t.api.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
    t.api.hasResourceProperties('AWS::WAFv2::LoggingConfiguration', {
      RedactedFields: [{ SingleHeader: { Name: 'authorization' } }],
    });
  });

  it('runs the API hardened, with secrets from Secrets Manager only', () => {
    const [taskDef] = Object.values(t.api.findResources('AWS::ECS::TaskDefinition'));
    const container = (
      taskDef as { Properties: { ContainerDefinitions: Record<string, unknown>[] } }
    ).Properties.ContainerDefinitions[0]!;
    expect(container.ReadonlyRootFilesystem).toBe(true);
    expect(container.User).toBe('65532');
    const envNames = (container.Environment as { Name: string }[]).map((e) => e.Name);
    expect(envNames.filter((n) => /PASSWORD|SECRET|KEY/.test(n))).toEqual([]);
    const secretNames = (container.Secrets as { Name: string }[]).map((s) => s.Name);
    expect(secretNames).toEqual(
      expect.arrayContaining(['DATABASE_USER', 'SERVER_SECRET', 'TWO_FACTOR_ENCRYPTION_KEY']),
    );
    // The password is read from Secrets Manager at connect time, not frozen at task start.
    expect(secretNames).not.toContain('DATABASE_PASSWORD');
    expect(envNames).toEqual(
      expect.arrayContaining(['DATABASE_CREDENTIALS_ARN', 'TRUST_PROXY_HOPS']),
    );
    t.api.hasResourceProperties('AWS::ECS::Service', {
      NetworkConfiguration: {
        AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'DISABLED' }),
      },
      EnableExecuteCommand: false,
    });
  });

  it('lets the API send email only as the Zvault sender', () => {
    t.api.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['ses:SendEmail', 'ses:SendRawEmail'],
            Condition: { StringEquals: { 'ses:FromAddress': 'no-reply@zvault.test' } },
          }),
        ]),
      },
    });
    t.email.hasResourceProperties('AWS::SES::ConfigurationSet', {
      DeliveryOptions: { TlsPolicy: 'REQUIRE' },
    });
    t.email.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: '_dmarc.zvault.test.',
      Type: 'TXT',
    });
  });

  it('records a validated, encrypted, multi-region audit trail', () => {
    t.foundation.hasResourceProperties('AWS::CloudTrail::Trail', {
      IsMultiRegionTrail: true,
      EnableLogFileValidation: true,
      KMSKeyId: Match.anyValue(),
    });
    t.foundation.allResourcesProperties('AWS::KMS::Key', { EnableKeyRotation: true });
  });

  it('encrypts every log group with the logs key', () => {
    for (const template of Object.values(t)) {
      for (const logGroup of Object.values(template.findResources('AWS::Logs::LogGroup'))) {
        expect(
          (logGroup as { Properties: Record<string, unknown> }).Properties.KmsKeyId,
        ).toBeDefined();
      }
    }
  });
});

describe('loadStageConfig', () => {
  const context = {
    'zvault:stage': 'dev',
    'zvault:dev': {
      region: 'us-east-1',
      zoneName: 'x.test',
      hostedZoneId: 'Z00000000000000000000',
    },
  };

  it('refuses the placeholder hosted zone', () => {
    expect(() => loadStageConfig(new App({ context }))).toThrow(/placeholder hosted zone/);
  });

  it('allows placeholders for CI synth', () => {
    const config = loadStageConfig(
      new App({ context: { ...context, 'zvault:allowPlaceholders': 'true' } }),
    );
    expect(config.stage).toBe('dev');
    expect(config.retainData).toBe(false);
  });

  it('never lets prod drop data retention', () => {
    const config = buildStageConfig('prod', {
      region: 'us-east-1',
      zoneName: 'x.test',
      hostedZoneId: 'Z1',
      retainData: false,
    });
    expect(config.retainData).toBe(true);
  });
});
