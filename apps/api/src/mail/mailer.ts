export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Sends email. Pick the transport with `MAIL_TRANSPORT`; tests bind
 * `MemoryMailer` instead.
 */
export abstract class Mailer {
  abstract send(message: MailMessage): Promise<void>;

  /** Whether this transport is known to be able to reach `email` (SES sandbox). */
  async isVerified(_email: string): Promise<boolean> {
    return false;
  }
}
