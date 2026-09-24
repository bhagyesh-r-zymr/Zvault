import * as route53 from 'aws-cdk-lib/aws-route53';
import type { Construct } from 'constructs';
import type { StageConfig } from './config.js';

/** Imports the existing public zone by id, so synth needs no AWS lookups. */
export function importHostedZone(scope: Construct, config: StageConfig): route53.IHostedZone {
  return route53.HostedZone.fromHostedZoneAttributes(scope, 'HostedZone', {
    hostedZoneId: config.hostedZoneId,
    zoneName: config.zoneName,
  });
}
