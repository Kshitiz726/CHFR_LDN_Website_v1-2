/**
 * Provider-agnostic WhatsApp contract.
 *
 * Nothing outside src/services/whatsapp/ knows that OpenWA exists. Swapping to
 * the WhatsApp Business Cloud API later means adding one file that implements
 * this interface and changing the factory in ./index.ts.
 */

export interface WhatsAppSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  /** True when the provider is deliberately switched off rather than broken. */
  skipped?: boolean;
}

export type WhatsAppConnectionState = 'CONNECTED' | 'DISCONNECTED' | 'QR_REQUIRED' | 'UNKNOWN' | 'NOT_CONFIGURED';

export interface WhatsAppStatus {
  state: WhatsAppConnectionState;
  sessionId?: string;
  detail?: string;
  error?: string;
}

export interface WhatsAppProvider {
  readonly name: string;
  readonly configured: boolean;

  /** `to` is E.164 including the leading '+'. */
  sendText(to: string, body: string): Promise<WhatsAppSendResult>;
  status(): Promise<WhatsAppStatus>;

  /** Session management is optional — a provider may not expose it. */
  start?(): Promise<{ ok: boolean; error?: string }>;
  stop?(): Promise<{ ok: boolean; error?: string }>;
  qr?(): Promise<{ ok: boolean; qr?: string; error?: string }>;
}
