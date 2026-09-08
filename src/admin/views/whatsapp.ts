import { esc } from '../../utils/html.js';
import type { WhatsAppStatus } from '../../services/whatsapp/index.js';
import { csrfInput, notices } from './components.js';

export interface WhatsAppPageProps {
  status: WhatsAppStatus;
  configured: boolean;
  qr?: string | null;
  businessNumber?: string;
  csrf: string;
  isAdmin: boolean;
  flash: { ok?: string; err?: string; warn?: string };
}

/**
 * WhatsApp session control. The browser only ever talks to our own routes —
 * the OpenWA base URL and API key never reach the page.
 */
export function whatsappPage(p: WhatsAppPageProps): string {
  const csrf = csrfInput(p.csrf);
  const dot =
    p.status.state === 'CONNECTED' ? 'ok' : p.status.state === 'QR_REQUIRED' ? 'warn' : p.status.state === 'NOT_CONFIGURED' ? 'off' : 'err';

  return `
<div class="page-head">
  <div>
    <div class="kicker">Integrations</div>
    <h1>WhatsApp</h1>
    <p class="sub">Self-hosted OpenWA gateway. New bookings are pushed to the CHFR business number.</p>
  </div>
</div>

${notices(p.flash)}

<div class="grid2">
  <section class="panel">
    <div class="section-title">Session</div>
    <dl class="kv">
      <dt>Status</dt><dd><span class="dot ${dot}"></span>${esc(p.status.state.replace(/_/g, ' '))}</dd>
      <dt>Session</dt><dd>${esc(p.status.sessionId ?? '—')}</dd>
      <dt>Business number</dt><dd>${esc(p.businessNumber ?? 'Not set (CHFR_WHATSAPP_NUMBER)')}</dd>
      <dt>Detail</dt><dd>${esc(p.status.detail ?? p.status.error ?? '—')}</dd>
    </dl>

    ${
      p.configured
        ? `<div class="btn-row" style="margin-top:20px">
             <form method="post" action="/admin/whatsapp/connect" style="display:inline">${csrf}
               <button class="btn ghost sm" type="submit">Connect</button></form>
             <form method="post" action="/admin/whatsapp/qr" style="display:inline">${csrf}
               <button class="btn ghost sm" type="submit">Refresh QR</button></form>
             ${
               p.isAdmin
                 ? `<form method="post" action="/admin/whatsapp/disconnect" style="display:inline"
                          data-confirm="Disconnect the CHFR WhatsApp session? New bookings will stop reaching WhatsApp until it is reconnected.">
                      ${csrf}<button class="btn danger sm" type="submit">Disconnect</button></form>`
                 : ''
             }
           </div>

           <form method="post" action="/admin/whatsapp/test" style="margin-top:22px"
                 data-confirm="Send a test WhatsApp message to the CHFR business number?">
             ${csrf}
             <div class="flabel" style="margin-bottom:8px">Send a test message</div>
             <textarea name="message" rows="2">CHFR system test — WhatsApp notifications are working.</textarea>
             <div class="btn-row" style="margin-top:12px">
               <button class="btn ghost sm" type="submit">Send test message</button>
             </div>
           </form>`
        : `<p class="sub" style="margin-top:18px">
             WhatsApp is not configured. Set <code>WHATSAPP_ENABLED=true</code>,
             <code>OPENWA_BASE_URL</code>, <code>OPENWA_API_KEY</code>,
             <code>OPENWA_SESSION_ID</code> and <code>CHFR_WHATSAPP_NUMBER</code>, then restart.
           </p>`
    }
  </section>

  <section class="panel">
    <div class="section-title">Pairing</div>
    ${
      p.qr
        ? `<p class="sub" style="margin-top:0">
             Open WhatsApp on the CHFR phone → <b>Settings → Linked devices → Link a device</b>, then scan this code.
           </p>
           ${
             p.qr.startsWith('data:image')
               ? `<img src="${esc(p.qr)}" alt="WhatsApp pairing QR code" style="width:260px;background:#fff;padding:12px;margin-top:16px">`
               : `<pre style="background:#0d0d0d;border:1px solid #303030;padding:14px;overflow:auto;font-size:11px;margin-top:16px">${esc(p.qr)}</pre>`
           }`
        : `<p class="sub" style="margin-top:0">
             ${
               p.status.state === 'CONNECTED'
                 ? 'The session is connected — no pairing needed.'
                 : 'No QR code available. Press Connect, then Refresh QR.'
             }
           </p>`
    }
    <p class="sub" style="margin-top:20px;font-size:11.5px">
      WhatsApp delivery is best-effort by design. If the session drops, bookings are still saved,
      emailed and exported — the WhatsApp notification is simply marked failed and can be re-sent
      from the booking page.
    </p>
  </section>
</div>`;
}
