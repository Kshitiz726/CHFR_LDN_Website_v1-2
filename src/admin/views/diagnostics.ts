import { esc } from '../../utils/html.js';
import { formatDateTime } from '../../utils/dates.js';
import type { UserRow } from '../../repositories/users.js';
import type { HealthReport } from '../../services/health.js';
import type { NotificationLogRow } from '../../repositories/notifications.js';
import { csrfInput } from './components.js';

export interface DiagnosticsProps {
  health: HealthReport;
  failures: NotificationLogRow[];
  user: UserRow;
  csrf: string;
  emailProvider: string;
  sender: string;
  adminEmail: string;
  /** Raw outcome of a test send, shown verbatim. */
  testResult?: { ok: boolean; recipient: string; detail: string; raw?: string };
}

/**
 * Email diagnostics.
 *
 * The point of this page is that it shows the provider's own words, untouched.
 * "Something went wrong" is useless when a message is not arriving; the actual
 * API response is what identifies the problem.
 */
export function diagnosticsPage(p: DiagnosticsProps): string {
  const e = p.health.checks.email;

  return `
<div class="page-head">
  <div>
    <div class="kicker">Diagnostics</div>
    <h1>Email delivery</h1>
    <p class="sub">Send a real message and see exactly what the provider says back.</p>
  </div>
  <div class="btn-row"><a class="btn ghost" href="/admin">Back to overview</a></div>
</div>

${
  p.testResult
    ? `<div class="notice ${p.testResult.ok ? 'ok' : 'err'}">
         <strong>${p.testResult.ok ? 'Accepted by the provider' : 'Rejected'}</strong> —
         ${esc(p.testResult.recipient)}<br>
         ${esc(p.testResult.detail)}
         ${
           p.testResult.raw
             ? `<pre style="margin:12px 0 0;padding:12px;background:#0d0d0d;border:1px solid #303030;
                        overflow:auto;font-size:11.5px;line-height:1.6;white-space:pre-wrap">${esc(p.testResult.raw)}</pre>`
             : ''
         }
         ${
           p.testResult.ok
             ? `<div style="margin-top:12px;font-size:12px;color:#a8e6c9">
                  Accepted only means the provider took the message. If it still does not arrive,
                  check the provider's own delivery log — it will show bounced or blocked.
                </div>`
             : ''
         }
       </div>`
    : ''
}

<div class="grid2">
  <section class="panel">
    <div class="section-title">Current configuration</div>
    <dl class="kv">
      <dt>Provider</dt><dd>${esc(p.emailProvider)}</dd>
      <dt>Sending from</dt><dd>${esc(p.sender)}</dd>
      <dt>Booking alerts to</dt><dd>${esc(p.adminEmail)}</dd>
      <dt>Status</dt><dd>${esc(e.status)}</dd>
    </dl>
    ${
      e.detail
        ? `<p class="sub" style="margin-top:14px;font-size:12px;line-height:1.7">${esc(e.detail)}</p>`
        : ''
    }
  </section>

  <section class="panel">
    <div class="section-title">Send a test email</div>
    <form method="post" action="/admin/diagnostics/email">
      ${csrfInput(p.csrf)}
      <label style="display:flex;flex-direction:column;gap:7px;font-size:9.5px;letter-spacing:1.5px;
                    text-transform:uppercase;color:var(--dim);font-weight:700">
        Send to
        <input type="email" name="recipient" required value="${esc(p.adminEmail)}"
               style="width:100%">
      </label>
      <div class="btn-row" style="margin-top:16px">
        <button class="btn" type="submit">Send test email</button>
      </div>
    </form>
    <p class="sub" style="margin-top:16px;font-size:11.5px;line-height:1.7">
      This sends a real message through the configured provider and prints the
      response verbatim — including any rejection reason.
    </p>
  </section>
</div>

<section class="panel">
  <div class="section-title">Recent delivery failures</div>
  ${
    p.failures.length === 0
      ? `<p class="sub" style="margin:0">No recorded failures. If mail is still not arriving, the provider
           accepted it and dropped it later — check the provider's delivery log.</p>`
      : `<div class="table-scroll"><table style="min-width:0">
           <thead><tr><th class="nowrap">When</th><th>Channel</th><th>To</th><th class="nowrap">Tries</th><th>Provider said</th></tr></thead>
           <tbody>${p.failures
             .map(
               (f) => `<tr>
                 <td class="nowrap">${esc(formatDateTime(f.created_at))}</td>
                 <td class="nowrap">${esc(f.channel)}<span class="muted">${esc(f.kind)}</span></td>
                 <td class="nowrap">${esc(f.recipient ?? '—')}</td>
                 <td class="nowrap">${f.attempts}</td>
                 <td style="max-width:520px;word-break:break-word;font-size:11.5px;line-height:1.6">${esc(f.error_message ?? '—')}</td>
               </tr>`,
             )
             .join('')}</tbody>
         </table></div>`
  }
</section>`;
}
