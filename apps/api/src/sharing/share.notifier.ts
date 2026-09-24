import { Injectable, Logger } from '@nestjs/common';
import { Mailer } from '../mail/mailer.js';
import { shareReceivedEmail } from '../mail/templates.js';

export interface ShareReceivedNotice {
  shareId: string;
  senderEmail: string;
  recipientEmail: string;
}

/**
 * Tells a recipient that something was shared with them. The notice carries
 * no item data and no key: the recipient opens the share in the app.
 */
export interface ShareNotifier {
  shareReceived(notice: ShareReceivedNotice): Promise<void>;
}

export const SHARE_NOTIFIER = Symbol('SHARE_NOTIFIER');

/**
 * Emails the recipient with the configured mailer. The share is already stored
 * and shows up in their app, so a failed email is logged, not raised.
 */
@Injectable()
export class MailShareNotifier implements ShareNotifier {
  private readonly logger = new Logger('ShareNotifier');

  constructor(private readonly mailer: Mailer) {}

  async shareReceived(notice: ShareReceivedNotice): Promise<void> {
    try {
      await this.mailer.send(shareReceivedEmail(notice.recipientEmail, notice.senderEmail));
    } catch (err) {
      // Ids only: email addresses are personal data and stay out of logs.
      this.logger.error(`Could not email the recipient of share ${notice.shareId}: ${String(err)}`);
    }
  }
}
