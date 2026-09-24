import { Stack, type StackProps } from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ses from 'aws-cdk-lib/aws-ses';
import type { Construct } from 'constructs';
import type { StageConfig } from '../config.js';
import { importHostedZone } from '../hosted-zone.js';

export interface EmailStackProps extends StackProps {
  readonly config: StageConfig;
}

/**
 * SES domain identity (Easy DKIM, custom MAIL FROM, DMARC) and a configuration set that requires
 * TLS to receiving servers and suppresses bounced and complained addresses.
 *
 * New SES accounts start in the sandbox; request production access before real users sign up.
 */
export class EmailStack extends Stack {
  readonly identity: ses.EmailIdentity;
  readonly configurationSet: ses.ConfigurationSet;
  readonly fromAddress: string;

  constructor(scope: Construct, id: string, props: EmailStackProps) {
    super(scope, id, props);
    const { config } = props;
    const hostedZone = importHostedZone(this, config);

    this.fromAddress = `${config.emailFromLocalPart}@${config.zoneName}`;

    this.configurationSet = new ses.ConfigurationSet(this, 'ConfigurationSet', {
      configurationSetName: `zvault-${config.stage}`,
      tlsPolicy: ses.ConfigurationSetTlsPolicy.REQUIRE,
      reputationMetrics: true,
      sendingEnabled: true,
      suppressionReasons: ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS,
    });
    this.configurationSet.addEventDestination('Metrics', {
      destination: ses.EventDestination.cloudWatchDimensions([
        {
          name: 'ses:configuration-set',
          source: ses.CloudWatchDimensionSource.MESSAGE_TAG,
          defaultValue: `zvault-${config.stage}`,
        },
      ]),
      events: [
        ses.EmailSendingEvent.SEND,
        ses.EmailSendingEvent.DELIVERY,
        ses.EmailSendingEvent.BOUNCE,
        ses.EmailSendingEvent.COMPLAINT,
        ses.EmailSendingEvent.REJECT,
      ],
    });

    // Creates the DKIM CNAMEs and MAIL FROM MX/SPF records in the hosted zone.
    this.identity = new ses.EmailIdentity(this, 'DomainIdentity', {
      identity: ses.Identity.publicHostedZone(hostedZone),
      configurationSet: this.configurationSet,
      mailFromDomain: `mail.${config.zoneName}`,
      mailFromBehaviorOnMxFailure: ses.MailFromBehaviorOnMxFailure.REJECT_MESSAGE,
    });

    new route53.TxtRecord(this, 'Dmarc', {
      zone: hostedZone,
      recordName: `_dmarc.${config.zoneName}`,
      values: ['v=DMARC1; p=quarantine; adkim=s; aspf=r; pct=100'],
    });
  }
}
