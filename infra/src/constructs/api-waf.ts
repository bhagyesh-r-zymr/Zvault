import { ArnFormat, Stack, type RemovalPolicy } from 'aws-cdk-lib';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

export interface ApiWafProps {
  readonly stage: string;
  /** The regional resource to protect (the API load balancer). */
  readonly resourceArn: string;
  readonly logsKey: kms.IKey;
  readonly logRetentionDays: number;
  readonly removalPolicy: RemovalPolicy;
}

/** Per-IP requests allowed in any 5-minute window. */
export const RATE_LIMITS = { auth: 100, all: 2000 } as const;
/** Login, sign-up and email verification live under this prefix. */
export const AUTH_PATH_PREFIX = '/v1/auth';

const visibility = (metricName: string): wafv2.CfnWebACL.VisibilityConfigProperty => ({
  cloudWatchMetricsEnabled: true,
  sampledRequestsEnabled: true,
  metricName,
});

const managedRule = (
  name: string,
  priority: number,
  ruleActionOverrides?: wafv2.CfnWebACL.RuleActionOverrideProperty[],
): wafv2.CfnWebACL.RuleProperty => ({
  name,
  priority,
  overrideAction: { none: {} },
  statement: {
    managedRuleGroupStatement: {
      vendorName: 'AWS',
      name,
      ...(ruleActionOverrides ? { ruleActionOverrides } : {}),
    },
  },
  visibilityConfig: visibility(name),
});

/**
 * Regional WAF for the API: brute-force throttling on auth endpoints, a global per-IP rate
 * limit, and AWS managed rule groups. Logs go to KMS-encrypted CloudWatch Logs with the
 * Authorization header redacted.
 */
export class ApiWaf extends Construct {
  readonly webAcl: wafv2.CfnWebACL;

  constructor(scope: Construct, id: string, props: ApiWafProps) {
    super(scope, id);

    this.webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: `zvault-${props.stage}-api`,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: visibility(`zvault-${props.stage}-api`),
      rules: [
        {
          name: 'RateLimitAuth',
          priority: 0,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: RATE_LIMITS.auth,
              evaluationWindowSec: 300,
              aggregateKeyType: 'IP',
              scopeDownStatement: {
                byteMatchStatement: {
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: 'STARTS_WITH',
                  searchString: AUTH_PATH_PREFIX,
                  textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
                },
              },
            },
          },
          visibilityConfig: visibility('RateLimitAuth'),
        },
        {
          name: 'RateLimitAll',
          priority: 1,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: RATE_LIMITS.all,
              evaluationWindowSec: 300,
              aggregateKeyType: 'IP',
            },
          },
          visibilityConfig: visibility('RateLimitAll'),
        },
        managedRule('AWSManagedRulesAmazonIpReputationList', 2),
        // Vault items are ciphertext up to the API's 1 MB body cap, well above the rule
        // group's 8 KB body limit, so that one rule only counts.
        managedRule('AWSManagedRulesCommonRuleSet', 3, [
          { name: 'SizeRestrictions_BODY', actionToUse: { count: {} } },
        ]),
        managedRule('AWSManagedRulesKnownBadInputsRuleSet', 4),
      ],
    });

    new wafv2.CfnWebACLAssociation(this, 'Association', {
      resourceArn: props.resourceArn,
      webAclArn: this.webAcl.attrArn,
    });

    // WAF requires the log group name to start with "aws-waf-logs-".
    const logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `aws-waf-logs-zvault-${props.stage}-api`,
      encryptionKey: props.logsKey,
      retention: props.logRetentionDays,
      removalPolicy: props.removalPolicy,
    });
    new wafv2.CfnLoggingConfiguration(this, 'Logging', {
      resourceArn: this.webAcl.attrArn,
      // WAF wants the bare log group ARN, without the ":*" suffix logGroupArn carries.
      logDestinationConfigs: [
        Stack.of(this).formatArn({
          service: 'logs',
          resource: 'log-group',
          resourceName: logGroup.logGroupName,
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
        }),
      ],
      redactedFields: [{ singleHeader: { Name: 'authorization' } }],
    });
  }
}
