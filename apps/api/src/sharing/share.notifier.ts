import { Injectable, Logger } from '@nestjs/common';

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

/** Development stand-in until the transactional mailer is wired in. */
@Injectable()
export class LoggingShareNotifier implements ShareNotifier {
  private readonly logger = new Logger('ShareNotifier');

  shareReceived(notice: ShareReceivedNotice): Promise<void> {
    // Ids only: email addresses are personal data and stay out of logs.
    this.logger.log(`share ${notice.shareId} delivered; recipient notification pending mailer`);
    return Promise.resolve();
  }
}
