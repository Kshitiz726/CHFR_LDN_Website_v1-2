import { config } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { toWhatsAppChatId } from '../../utils/phone.js';
import type {
  WhatsAppProvider,
  WhatsAppSendResult,
  WhatsAppStatus,
  WhatsAppConnectionState,
} from './provider.js';

/**
 * OpenWA (github.com/rmyndharis/OpenWA) REST adapter.
 *
 * Endpoints, verified against the project's documented API:
 *   POST /api/sessions                              { name }
 *   POST /api/sessions/{id}/start
 *   GET  /api/sessions/{id}
 *   GET  /api/sessions/{id}/qr
 *   POST /api/sessions/{id}/messages/send-text      { chatId, text }
 *
 * Auth is the `X-API-Key` header. The key is read from config and never leaves
 * the server — the browser talks to our /api/admin/whatsapp routes instead.
 */
export class OpenWAProvider implements WhatsAppProvider {
  readonly name = 'openwa';

  constructor(
    private readonly baseUrl = config.OPENWA_BASE_URL,
    private readonly apiKey = config.OPENWA_API_KEY,
    private readonly sessionId = config.OPENWA_SESSION_ID,
    private readonly timeoutMs = config.OPENWA_TIMEOUT_MS,
  ) {}

  get configured(): boolean {
    return Boolean(config.WHATSAPP_ENABLED && this.baseUrl && this.apiKey && this.sessionId);
  }

  private url(path: string): string {
    return `${(this.baseUrl ?? '').replace(/\/+$/, '')}${path}`;
  }

  private async request<T = any>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url(path), {
        method: init.method ?? 'GET',
        headers: {
          'X-API-Key': this.apiKey ?? '',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });

      const text = await res.text();
      let data: any;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = text;
      }

      if (!res.ok) {
        const detail =
          (data && typeof data === 'object' && (data.message ?? data.error)) ||
          (typeof data === 'string' ? data.slice(0, 200) : '') ||
          res.statusText;
        return { ok: false, status: res.status, error: `OpenWA ${res.status}: ${detail}` };
      }
      return { ok: true, status: res.status, data };
    } catch (err) {
      const message =
        err instanceof Error && err.name === 'AbortError'
          ? `OpenWA request timed out after ${this.timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      return { ok: false, status: 0, error: message };
    } finally {
      clearTimeout(timer);
    }
  }

  async sendText(to: string, body: string): Promise<WhatsAppSendResult> {
    if (!this.configured) {
      return { ok: false, skipped: true, error: 'WhatsApp is not configured' };
    }

    const chatId = toWhatsAppChatId(to);
    if (!chatId) {
      return { ok: false, error: `Invalid WhatsApp destination number: ${to}` };
    }

    const res = await this.request(`/api/sessions/${encodeURIComponent(this.sessionId!)}/messages/send-text`, {
      method: 'POST',
      body: { chatId, text: body },
    });

    if (!res.ok) {
      logger.warn({ error: res.error, chatId }, 'OpenWA send failed');
      return { ok: false, error: res.error };
    }

    // Response shape varies by version; look for the id wherever it lands.
    const d: any = res.data ?? {};
    const messageId =
      d.id ?? d.messageId ?? d.data?.id ?? d.data?.messageId ?? d.result?.id ?? undefined;

    return { ok: true, messageId: messageId ? String(messageId) : undefined };
  }

  async status(): Promise<WhatsAppStatus> {
    if (!this.configured) {
      return { state: 'NOT_CONFIGURED', detail: 'OPENWA_BASE_URL / OPENWA_API_KEY / OPENWA_SESSION_ID not set' };
    }

    const res = await this.request(`/api/sessions/${encodeURIComponent(this.sessionId!)}`);
    if (!res.ok) {
      return { state: 'DISCONNECTED', sessionId: this.sessionId, error: res.error };
    }

    const d: any = res.data ?? {};
    const raw = String(d.status ?? d.state ?? d.data?.status ?? d.data?.state ?? '').toUpperCase();
    return {
      state: mapState(raw),
      sessionId: this.sessionId,
      detail: raw || undefined,
    };
  }

  async start(): Promise<{ ok: boolean; error?: string }> {
    if (!this.configured) return { ok: false, error: 'WhatsApp is not configured' };

    // Creating the session is idempotent in effect: an "already exists" error
    // is expected on every start after the first, so it is not fatal.
    const created = await this.request('/api/sessions', { method: 'POST', body: { name: this.sessionId } });
    if (!created.ok && created.status !== 409 && created.status !== 400) {
      logger.warn({ error: created.error }, 'OpenWA session create returned an unexpected error');
    }

    const started = await this.request(`/api/sessions/${encodeURIComponent(this.sessionId!)}/start`, { method: 'POST' });
    return started.ok ? { ok: true } : { ok: false, error: started.error };
  }

  async stop(): Promise<{ ok: boolean; error?: string }> {
    if (!this.configured) return { ok: false, error: 'WhatsApp is not configured' };
    const res = await this.request(`/api/sessions/${encodeURIComponent(this.sessionId!)}/stop`, { method: 'POST' });
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }

  async qr(): Promise<{ ok: boolean; qr?: string; error?: string }> {
    if (!this.configured) return { ok: false, error: 'WhatsApp is not configured' };
    const res = await this.request(`/api/sessions/${encodeURIComponent(this.sessionId!)}/qr`);
    if (!res.ok) return { ok: false, error: res.error };

    const d: any = res.data ?? {};
    const qr = typeof d === 'string' ? d : (d.qr ?? d.qrCode ?? d.data?.qr ?? d.data?.qrCode);
    return qr ? { ok: true, qr: String(qr) } : { ok: false, error: 'OpenWA did not return a QR code' };
  }
}

function mapState(raw: string): WhatsAppConnectionState {
  if (!raw) return 'UNKNOWN';
  if (/CONNECTED|AUTHENTICATED|READY|WORKING|ONLINE/.test(raw)) return 'CONNECTED';
  if (/QR|SCAN|PAIRING|UNPAIRED/.test(raw)) return 'QR_REQUIRED';
  if (/DISCONNECT|STOPPED|FAILED|CLOSED|OFFLINE|TIMEOUT/.test(raw)) return 'DISCONNECTED';
  return 'UNKNOWN';
}
