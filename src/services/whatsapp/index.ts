import { config } from '../../config/env.js';
import { OpenWAProvider } from './openwa.js';
import type { WhatsAppProvider, WhatsAppStatus } from './provider.js';

export type { WhatsAppProvider, WhatsAppSendResult, WhatsAppStatus } from './provider.js';

/** Stand-in used when WhatsApp is switched off. Never throws, never blocks. */
export class DisabledWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'disabled';
  readonly configured = false;

  async sendText(): Promise<{ ok: boolean; skipped: boolean; error: string }> {
    return { ok: false, skipped: true, error: 'WhatsApp integration is disabled' };
  }

  async status(): Promise<WhatsAppStatus> {
    return { state: 'NOT_CONFIGURED', detail: 'WHATSAPP_ENABLED is false' };
  }
}

let provider: WhatsAppProvider | undefined;

export function whatsAppProvider(): WhatsAppProvider {
  if (!provider) {
    provider = config.WHATSAPP_ENABLED ? new OpenWAProvider() : new DisabledWhatsAppProvider();
  }
  return provider;
}

/** Test/bootstrap seam so a fake provider can be injected. */
export function setWhatsAppProvider(next: WhatsAppProvider | undefined): void {
  provider = next;
}
