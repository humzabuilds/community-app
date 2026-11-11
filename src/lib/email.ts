import type { Env } from '../config';

export type Email = { to: string; subject: string; text: string };

export interface EmailSender {
  send(msg: Email): Promise<void>;
}

// Local development: print to the console and keep a copy in dev_outbox
// so /dev/outbox can show it. Nothing leaves the machine.
export class ConsoleSender implements EmailSender {
  constructor(private db: D1Database) {}
  async send(msg: Email) {
    console.log(`\n[email] to=${msg.to} subject=${msg.subject}\n${msg.text}\n`);
    await this.db.prepare('INSERT INTO dev_outbox (to_email, subject, body) VALUES (?, ?, ?)').bind(msg.to, msg.subject, msg.text).run();
  }
}

// Sends through Resend (https://resend.com). Needs RESEND_API_KEY (a secret) and EMAIL_FROM,
// an address on a domain you verified there, for example "My Community <hello@yourdomain.com>".
export class ResendSender implements EmailSender {
  constructor(private apiKey: string | undefined, private from: string | undefined) {}
  async send(msg: Email): Promise<void> {
    if (!this.apiKey || !this.from) throw new Error('Set RESEND_API_KEY and EMAIL_FROM to send email. See the README.');
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [msg.to], subject: msg.subject, text: msg.text }),
    });
    if (!r.ok) throw new Error(`Resend refused the email (${r.status}).`);
  }
}

// Alternative with no email provider: queue the message in mail_queue. A small script you run
// yourself reads GET /relay/mail with RELAY_TOKEN, sends each message from your own mailbox,
// and confirms with POST /relay/mail/ack.
export class RelaySender implements EmailSender {
  constructor(private db: D1Database) {}
  async send(msg: Email) {
    await this.db.prepare('INSERT INTO mail_queue (to_email, subject, body) VALUES (?, ?, ?)').bind(msg.to, msg.subject, msg.text).run();
  }
}

export function getSender(env: Env): EmailSender {
  const provider = env.EMAIL_PROVIDER || 'console';
  if (provider === 'relay') return new RelaySender(env.DB);
  if (provider === 'resend') return new ResendSender(env.RESEND_API_KEY, env.EMAIL_FROM);
  return new ConsoleSender(env.DB);
}
