import type { MailMessage } from './mailer.js';

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const layout = (title: string, body: string) => `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111;max-width:480px;margin:auto;padding:24px">
<h2 style="margin-top:0">${escape(title)}</h2>
${body}
<p style="color:#666;font-size:12px;margin-top:32px">Zvault staff will never ask for this code, your master password or your Secret Key.</p>
</body></html>`;

export function verificationCodeEmail(to: string, code: string, minutes: number): MailMessage {
  return {
    to,
    subject: `${code} is your Zvault verification code`,
    text: [
      `Your Zvault verification code is ${code}.`,
      '',
      `Enter it in the Zvault app to confirm this email address. It expires in ${minutes} minutes.`,
      '',
      "If you didn't try to create a Zvault account, you can ignore this email.",
    ].join('\n'),
    html: layout(
      'Confirm your email',
      `<p>Enter this code in the Zvault app. It expires in ${minutes} minutes.</p>
<p style="font-size:32px;letter-spacing:8px;font-weight:600">${escape(code)}</p>
<p>If you didn't try to create a Zvault account, you can ignore this email.</p>`,
    ),
  };
}

/** Sent instead of a code when the address already has an account. */
export function alreadyRegisteredEmail(to: string): MailMessage {
  return {
    to,
    subject: 'You already have a Zvault account',
    text: [
      'Someone tried to create a Zvault account with this email address, but you already have one.',
      '',
      'Sign in with your master password and Secret Key instead. If this was not you, no action is needed.',
    ].join('\n'),
    html: layout(
      'You already have an account',
      `<p>Someone tried to create a Zvault account with this email address, but you already have one.</p>
<p>Sign in with your master password and Secret Key instead. If this wasn't you, no action is needed.</p>`,
    ),
  };
}

/** Tells a Zvault user that someone shared an item with them. Carries no item data. */
export function shareReceivedEmail(to: string, senderEmail: string): MailMessage {
  return {
    to,
    subject: `${senderEmail} shared an item with you in Zvault`,
    text: [
      `${senderEmail} shared an item with you in Zvault.`,
      '',
      'Open the Zvault app and go to Sharing to see it. It is end-to-end encrypted, so only your Zvault can open it.',
      '',
      "If you don't know the sender, you can ignore this email.",
    ].join('\n'),
    html: layout(
      'Something was shared with you',
      `<p><strong>${escape(senderEmail)}</strong> shared an item with you in Zvault.</p>
<p>Open the Zvault app and go to <strong>Sharing</strong> to see it. It is end-to-end encrypted, so only your Zvault can open it.</p>
<p>If you don't know the sender, you can ignore this email.</p>`,
    ),
  };
}
