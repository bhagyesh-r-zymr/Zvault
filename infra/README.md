# Zvault infrastructure (AWS CDK)

Infrastructure as code for the Zvault API. Nothing here is deployed automatically: CI only runs
`cdk synth` checks and unit tests. A person deploys with their own AWS credentials.

## What it creates

Four stacks per stage (`dev`, `prod`). Stateful resources sit apart from the API so the API stack
can be torn down and redeployed on its own.

| Stack                       | Contents                                                                                                                                                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Zvault-<stage>-Foundation` | KMS keys (data, logs, audit; yearly rotation), VPC (public / app / isolated data subnets, flow logs), VPC endpoints (S3, Secrets Manager, KMS, Logs), access-log bucket, multi-region CloudTrail with log-file validation.                                             |
| `Zvault-<stage>-Data`       | Aurora PostgreSQL 17 Serverless v2 in isolated subnets: KMS-encrypted storage, TLS required (`rds.force_ssl`, TLS 1.2 minimum), IAM auth enabled, admin secret in Secrets Manager rotated every 30 days, Performance Insights, logs to encrypted CloudWatch.           |
| `Zvault-<stage>-Email`      | SES domain identity with Easy DKIM, custom MAIL FROM, DMARC record, configuration set that requires TLS and suppresses bounces and complaints.                                                                                                                         |
| `Zvault-<stage>-Api`        | NestJS API on ECS Fargate (ARM64, distroless, read-only root, non-root user) in private subnets; internet-facing ALB with an ACM certificate, TLS 1.2+ with post-quantum key exchange, HTTP→HTTPS redirect; AWS WAF; Route 53 alias; alarms to an encrypted SNS topic. |

### Security choices

- **Zero-knowledge stays intact.** The server stores ciphertext and SRP verifiers only; no infra
  component ever handles user keys. Database statement logging is limited to DDL so ciphertext
  never lands in logs.
- **Least-privilege IAM.** The API task role can only call `ses:SendEmail`/`SendRawEmail` on the
  Zvault identity, with `ses:FromAddress` pinned to the sender address. The execution role can
  read exactly the two secrets it injects. There are no IAM users and no SMTP credentials.
- **Network.** The database accepts port 5432 from the API tasks' security group only. Tasks have
  no public IP; only the ALB is public. ECS Exec is disabled.
- **WAF.** Per-IP rate limits (100 per 5 minutes on `/v1/auth*`, 2,000 per 5 minutes overall),
  AWS IP reputation list, Common Rule Set (body-size rule counts only, since vault items can
  exceed 8 KB) and Known Bad Inputs. WAF logs redact the `Authorization` header.
- **Encryption.** Customer-managed KMS keys for the database, secrets, every log group, the
  CloudTrail bucket and the alarm topic. Buckets block public access and deny non-TLS requests.
- **Checked on every synth.** [cdk-nag](https://github.com/cdklabs/cdk-nag) runs the AWS Solutions
  rule pack; synth and tests fail on any finding that is not acknowledged in code with a reason.

## Configuration

Settings per stage live in `cdk.json` under `zvault:dev` and `zvault:prod`:

| Key            | Meaning                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| `region`       | AWS region.                                                                                          |
| `account`      | Optional AWS account id. Defaults to the CLI's current account.                                      |
| `zoneName`     | Existing public Route 53 zone. The API is `api.<zoneName>`, mail is sent from `no-reply@<zoneName>`. |
| `hostedZoneId` | The zone's id. The placeholder value is refused at deploy time.                                      |
| `alarmEmail`   | Optional address subscribed to alarms.                                                               |

Sizes, retention and the rest are in `src/config.ts`. `prod` always keeps data on delete
(deletion protection, snapshot on removal, retained keys and buckets).

The API container gets these environment variables: `NODE_ENV`, `PORT`, `CORS_ORIGINS`,
`DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_SSL=true`, `MAIL_TRANSPORT=ses`, `SES_FROM_ADDRESS`,
`SES_CONFIGURATION_SET`, `APP_PUBLIC_URL`; and these from Secrets Manager: `DATABASE_USER`,
`DATABASE_PASSWORD`, `SERVER_SECRET`. Send email with `@aws-sdk/client-sesv2`; the task role
supplies credentials.

Database migrations run as a one-off Fargate task from the API image
(`node dist/db/migrate.js`). After each deploy that changes the schema, run the command in the
`MigrateCommand` output of the `Zvault-<stage>-Api` stack.

## Commands

```sh
pnpm --filter @zvault/infra test        # unit tests + cdk-nag, no AWS access needed
pnpm --filter @zvault/infra synth       # synthesize with placeholder DNS (CI)

# Deploying (a person, with AWS credentials; Docker must be running to build the API image)
cd infra
pnpm cdk bootstrap                      # once per account/region
pnpm cdk deploy -c zvault:stage=dev --all
```

## Before the first production deploy

1. Point `zoneName` and `hostedZoneId` at the real zone.
2. Request SES production access (new accounts start in the sandbox and can only email verified
   addresses).
3. Pin the two base images in `docker/api.Dockerfile` by digest.
4. Create a least-privilege database role for the API and keep `zvault_admin` for migrations only.
5. If the AWS organization already has an organization trail, set `enableCloudTrail: false`.
6. Consider enabling GuardDuty, Security Hub and AWS Config at the account level; they are
   account-wide, so they are not created here.
