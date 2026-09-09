import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type { EmailContent } from './templates/index.js';
// Safe despite resend.ts importing back from here: that import is type-only
// and erased at compile time, so there is no runtime cycle.
import { ResendTransport } from './resend.js';

/**
 * SMTP transport. Deliberately thin: templates produce the content, this module
 * only knows how to put it on the wire and report what happened.
 */

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  skipped?: boolean;
  /** The provider's untouched response, surfaced on the diagnostics page. */
  raw?: string;
}

export interface EmailTransport {
  send(to: string, content: EmailContent, replyTo?: string): Promise<SendResult>;
  verify(): Promise<{ ok: boolean; error?: string }>;
  readonly configured: boolean;
}

class SmtpTransport implements EmailTransport {
  readonly configured = true;
  private transporter: Transporter | undefined;

  private get tx(): Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        // Port 465 is implicit TLS; 587 upgrades via STARTTLS.
        secure: config.SMTP_SECURE || config.SMTP_PORT === 465,
        auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 20_000,
      });
    }
    return this.transporter;
  }

  async send(to: string, content: EmailContent, replyTo?: string): Promise<SendResult> {
    try {
      const info = await this.tx.sendMail({
        from: config.smtpFrom,
        to,
        replyTo,
        subject: content.subject,
        text: content.text,
        html: content.html,
      });
      return { ok: true, messageId: info.messageId };
    } catch (err) {
      // The message, never the credentials — nodemailer errors do not include
      // the password, but we keep this to the message string regardless.
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ to, subject: content.subject, error: message }, 'SMTP send failed');
      return { ok: false, error: message };
    }
  }

  async verify(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.tx.verify();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * Used when SMTP is not configured (local development, CI). Records what
 * *would* have been sent so tests and developers can assert on it, and reports
 * the send as skipped rather than pretending it succeeded.
 */
export class MemoryTransport implements EmailTransport {
  readonly configured = false;
  readonly outbox: Array<{ to: string; content: EmailContent; at: Date }> = [];

  async send(to: string, content: EmailContent): Promise<SendResult> {
    this.outbox.push({ to, content, at: new Date() });
    logger.info({ to, subject: content.subject }, 'Email captured (SMTP not configured)');
    return { ok: true, skipped: true, messageId: `memory-${this.outbox.length}` };
  }

  async verify(): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: 'SMTP is not configured' };
  }

  clear(): void {
    this.outbox.length = 0;
  }
}

let transport: EmailTransport | undefined;

/** Which transport the current configuration selects, without building it. */
export function emailProviderName(): 'resend' | 'smtp' | 'none' {
  if (!config.EMAIL_ENABLED) return 'none';
  if (config.EMAIL_PROVIDER === 'resend') return config.RESEND_API_KEY ? 'resend' : 'none';
  if (config.EMAIL_PROVIDER === 'smtp') return config.SMTP_HOST ? 'smtp' : 'none';
  // auto: HTTPS first, because SMTP ports are blocked on many hosts.
  if (config.RESEND_API_KEY) return 'resend';
  if (config.SMTP_HOST) return 'smtp';
  return 'none';
}

export function emailTransport(): EmailTransport {
  if (!transport) {
    const provider = emailProviderName();
    if (provider === 'resend') {
      transport = new ResendTransport();
    } else if (provider === 'smtp') {
      transport = new SmtpTransport();
    } else {
      transport = new MemoryTransport();
    }
  }
  return transport;
}

/** Test/bootstrap seam so a fake transport can be injected. */
export function setEmailTransport(next: EmailTransport | undefined): void {
  transport = next;
}

export function isEmailConfigured(): boolean {
  return emailProviderName() !== 'none';
}
