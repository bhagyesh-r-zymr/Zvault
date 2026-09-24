import nodemailer, { type Transporter } from 'nodemailer';
import type { Env } from '../config/env.js';
import { Mailer, type MailMessage } from './mailer.js';

/**
 * Sends over SMTP (Amazon SES, Postmark, Mailgun, ...). TLS is required unless
 * `SMTP_ALLOW_INSECURE` is set, which the env schema only allows outside production.
 */
export class SmtpMailer extends Mailer {
  private readonly transport: Transporter;

  constructor(private readonly env: Env) {
    super();
    this.transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      requireTLS: !env.SMTP_SECURE && !env.SMTP_ALLOW_INSECURE,
      tls: { minVersion: 'TLSv1.2' },
      ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS ?? '' } } : {}),
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.env.MAIL_FROM, ...message });
  }
}
