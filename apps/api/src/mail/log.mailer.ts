import { Logger } from '@nestjs/common';
import { Mailer, type MailMessage } from './mailer.js';

/**
 * Development transport: writes each message to the server log instead of
 * sending it, so sign-up codes can be read from the terminal. The env
 * schema refuses this transport in production.
 */
export class LogMailer extends Mailer {
  private readonly logger = new Logger('Mail');

  send(message: MailMessage): Promise<void> {
    this.logger.log(`To: ${message.to}\nSubject: ${message.subject}\n\n${message.text}`);
    return Promise.resolve();
  }
}
