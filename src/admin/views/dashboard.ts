import { esc } from '../../utils/html.js';
import { formatDateTime, formatLongDate, formatTime } from '../../utils/dates.js';
import type { BookingRow } from '../../domain/booking.js';
import type { RefOption } from '../../domain/refOptions.js';
import type { DashboardMetrics } from '../../repositories/bookings.js';
import type { NotificationLogRow } from '../../repositories/notifications.js';
import type { HealthReport } from '../../services/health.js';
import { statusBadge, notices } from './components.js';

export interface DashboardProps {
  metrics: DashboardMetrics;
  refs: Map<string, RefOption[]>;
  today: BookingRow[];
  upcoming: BookingRow[];
  newLeads: BookingRow[];
  failures: NotificationLogRow[];
  health: HealthReport;
  flash: { ok?: string; err?: string; warn?: string };
}

const CARD_STATUSES = ['NEW_LEAD', 'CONTACTED', 'QUOTED', 'CONFIRMED', 'COMPLETED'];

export function dashboardPage(p: DashboardProps): string {
  const statusOptions = p.refs.get('status') ?? [];

  // Overview cards follow the reference table, so a new status appears here
  // automatically once it is added to ref_options.
  const cards = statusOptions
    .filter((o) => CARD_STATUSES.includes(o.code))
    .map(
      (o) => `<a class="metric" href="/admin/bookings?status=${esc(o.code)}">
        <div class="label">${esc(o.label)}</div>
        <div class="value${o.code === 'NEW_LEAD' ? ' accent' : ''}">${p.metrics.statusCounts[o.code] ?? 0}</div>
      </a>`,
    )
    .join('');

  const goingToday = `<a class="metric" href="/admin/today">
      <div class="label">Going today</div>
      <div class="value">${p.metrics.goingToday}</div>
    </a>`;

  return `
<div class="page-head">
  <div>
    <div class="kicker">CHFR Operations</div>
    <h1>Overview</h1>
    <p class="sub">${p.metrics.todayCount} journey${p.metrics.todayCount === 1 ? '' : 's'} today · ${p.metrics.upcomingCount} upcoming · ${p.metrics.uncontactedCount} lead${p.metrics.uncontactedCount === 1 ? '' : 's'} not yet contacted</p>
  </div>
  <div class="btn-row">
    <a class="btn ghost" href="/admin/bookings">All bookings</a>
    <a class="btn" href="/admin/today">Today's operations</a>
  </div>
</div>

${notices(p.flash)}

<div class="cards">${cards}${goingToday}</div>

<div class="grid2">
  <section class="panel">
    <h2>Today's journeys</h2>
    ${journeyList(p.today, p.refs, 'No journeys scheduled for today.')}
    ${p.today.length ? `<div style="margin-top:16px"><a class="btn ghost sm" href="/admin/today">Open operations view</a></div>` : ''}
  </section>

  <section class="panel">
    <h2>Uncontacted leads</h2>
    ${leadList(p.newLeads)}
    ${p.newLeads.length ? `<div style="margin-top:16px"><a class="btn ghost sm" href="/admin/bookings?status=NEW_LEAD">See all new leads</a></div>` : ''}
  </section>
</div>

<div class="grid2">
  <section class="panel">
    <h2>Next journeys</h2>
    ${journeyList(p.upcoming, p.refs, 'Nothing upcoming.')}
    ${p.upcoming.length ? `<div style="margin-top:16px"><a class="btn ghost sm" href="/admin/upcoming">See upcoming</a></div>` : ''}
  </section>

  <section class="panel">
    <h2>System health</h2>
    ${healthGrid(p.health)}

    <h2 style="margin-top:26px">Failed notifications</h2>
    ${
      p.failures.length === 0
        ? `<p class="sub" style="margin:0">No notification failures. Every booking has reached email, spreadsheet and WhatsApp as configured.</p>`
        : `<div class="table-scroll"><table style="min-width:0">
             <thead><tr><th>Booking</th><th>Channel</th><th>When</th><th>Reason</th></tr></thead>
             <tbody>${p.failures
               .slice(0, 8)
               .map(
                 (f) => `<tr>
                   <td class="nowrap">${
                     f.booking_id
                       ? `<a href="/admin/bookings/${esc(f.booking_id)}" class="ref">${esc(f.booking_reference ?? f.booking_id)}</a>`
                       : '—'
                   }</td>
                   <td class="nowrap">${esc(f.channel)}<span class="muted">${esc(f.kind)}</span></td>
                   <td class="nowrap">${esc(formatDateTime(f.created_at))}</td>
                   <td><span class="truncate" title="${esc(f.error_message ?? '')}">${esc(f.error_message ?? '—')}</span></td>
                 </tr>`,
               )
               .join('')}</tbody>
           </table></div>`
    }
  </section>
</div>`;
}

function journeyList(rows: BookingRow[], refs: Map<string, RefOption[]>, emptyText: string): string {
  if (!rows.length) return `<p class="sub" style="margin:0">${esc(emptyText)}</p>`;
  return `<div class="table-scroll"><table style="min-width:0">
    <thead><tr><th class="nowrap">Time</th><th>Booking</th><th>Journey</th><th>Status</th></tr></thead>
    <tbody>${rows
      .map(
        (b) => `<tr>
          <td class="nowrap"><strong>${esc(formatTime(b.pickup_time))}</strong><span class="muted">${esc(formatLongDate(b.journey_date))}</span></td>
          <td class="nowrap"><a class="ref" href="/admin/bookings/${esc(b.id)}">${esc(b.booking_reference)}</a><span class="muted">${esc(b.full_name)}</span></td>
          <td><span class="truncate">${esc(b.pickup_location)}</span><span class="muted">→ ${esc(b.destination)}</span></td>
          <td class="nowrap">${statusBadge(refs, b.status)}</td>
        </tr>`,
      )
      .join('')}</tbody></table></div>`;
}

function leadList(rows: BookingRow[]): string {
  if (!rows.length) return `<p class="sub" style="margin:0">Every lead has been picked up. Nothing waiting.</p>`;
  return `<div class="table-scroll"><table style="min-width:0">
    <thead><tr><th>Booking</th><th>Customer</th><th>Journey date</th><th>Received</th></tr></thead>
    <tbody>${rows
      .map(
        (b) => `<tr>
          <td class="nowrap"><a class="ref" href="/admin/bookings/${esc(b.id)}">${esc(b.booking_reference)}</a></td>
          <td><span class="truncate">${esc(b.full_name)}</span><span class="muted">${esc(b.mobile)}</span></td>
          <td class="nowrap">${esc(formatLongDate(b.journey_date))}<span class="muted">${esc(formatTime(b.pickup_time))}</span></td>
          <td class="nowrap">${esc(formatDateTime(b.created_at))}</td>
        </tr>`,
      )
      .join('')}</tbody></table></div>`;
}

function healthGrid(h: HealthReport): string {
  const cell = (name: string, c: { status: string; detail?: string }) => {
    const dot =
      c.status === 'CONNECTED' || c.status === 'HEALTHY'
        ? 'ok'
        : c.status === 'NOT_CONFIGURED' || c.status === 'SKIPPED'
          ? 'off'
          : c.status === 'DEGRADED' || c.status === 'QR_REQUIRED'
            ? 'warn'
            : 'err';
    return `<div>
      <div class="n">${esc(name)}</div>
      <div class="s"><span class="dot ${dot}"></span>${esc(c.status.replace(/_/g, ' '))}</div>
      ${c.detail ? `<div class="muted" style="font-size:11px;color:#777;margin-top:5px">${esc(c.detail)}</div>` : ''}
    </div>`;
  };

  return `<div class="health">
    ${cell('Database', h.checks.database)}
    ${cell('Email', h.checks.email)}
    ${cell('Spreadsheet', h.checks.spreadsheet)}
    ${cell('WhatsApp', h.checks.whatsapp)}
    ${cell('Application', h.checks.application)}
  </div>`;
}
