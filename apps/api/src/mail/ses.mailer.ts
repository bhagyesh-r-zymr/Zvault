import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { Env } from '../config/env.js';
import { Mailer, type MailMessage } from './mailer.js';

/** Sends through the Amazon SES API using the ambient IAM role (ECS task role). */
export class SesMailer extends Mailer {
  private readonly client = new SESv2Client({});

  constructor(private readonly env: Env) {
    super();
  }

  async send(message: MailMessage): Promise<void> {
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.env.SES_FROM_ADDRESS ?? this.env.MAIL_FROM,
        Destination: { ToAddresses: [message.to] },
        ...(this.env.SES_CONFIGURATION_SET
          ? { ConfigurationSetName: this.env.SES_CONFIGURATION_SET }
          : {}),
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: message.text, Charset: 'UTF-8' },
              Html: { Data: message.html, Charset: 'UTF-8' },
            },
          },
        },
      }),
    );
  }
}
