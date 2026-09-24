import { Mailer, type MailMessage } from './mailer.js';

/** Keeps messages in memory. For tests. */
export class MemoryMailer extends Mailer {
  readonly sent: MailMessage[] = [];

  send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  lastTo(to: string): MailMessage | undefined {
    return this.sent.findLast((m) => m.to === to);
  }
}
