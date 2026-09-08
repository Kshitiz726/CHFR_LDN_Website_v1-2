import { esc } from '../../utils/html.js';
import { formatLongDate, formatTime } from '../../utils/dates.js';
import type { BookingRow } from '../../domain/booking.js';
import type { RefOption } from '../../domain/refOptions.js';
import { statusBadge, notices } from './components.js';

export interface TodayProps {
  rows: BookingRow[];
  date: string;
  refs: Map<string, RefOption[]>;
  flash: { ok?: string; err?: string; warn?: string };
}

/** Chronological run-sheet for the day. Designed to be read on a phone. */
export function todayPage(p: TodayProps): string {
  return `
<div class="page-head">
  <div>
    <div class="kicker">CHFR Operations</div>
    <h1>Today</h1>
    <p class="sub">${esc(formatLongDate(p.date))} · ${p.rows.length} journey${p.rows.length === 1 ? '' : 's'}</p>
  </div>
  <div class="btn-row">
    <a class="btn ghost" href="/api/admin/export/bookings?scope=today&format=csv">Export today (CSV)</a>
    <a class="btn ghost" href="/api/admin/export/bookings?scope=today&format=xlsx">Export today (Excel)</a>
    <a class="btn" href="/admin/upcoming">Upcoming</a>
  </div>
</div>

${notices(p.flash)}

${
  p.rows.length === 0
    ? `<div class="empty">No journeys scheduled for today.</div>`
    : `<div class="table-scroll"><table>
  <thead><tr>
    <th class="nowrap">Time</th><th>Booking</th><th>Customer</th>
    <th>Pickup</th><th>Destination</th><th>Vehicle</th>
    <th class="nowrap">Pax</th><th>Driver</th><th>Status</th><th>Notes</th>
  </tr></thead>
  <tbody>${p.rows
    .map(
      (b) => `<tr>
      <td class="nowrap"><strong style="font-size:15px">${esc(formatTime(b.pickup_time))}</strong></td>
      <td class="nowrap"><a class="ref" href="/admin/bookings/${esc(b.id)}">${esc(b.booking_reference)}</a></td>
      <td class="nowrap">${esc(b.full_name)}<span class="muted">${esc(b.mobile)}</span></td>
      <td><span class="truncate" title="${esc(b.pickup_location)}">${esc(b.pickup_location)}</span></td>
      <td><span class="truncate" title="${esc(b.destination)}">${esc(b.destination)}</span></td>
      <td class="nowrap">${esc(labelOf(p.refs, 'vehicle', b.preferred_vehicle))}</td>
      <td class="nowrap">${b.passengers}</td>
      <td class="nowrap">${esc(b.driver_name ?? '—')}</td>
      <td class="nowrap">${statusBadge(p.refs, b.status)}</td>
      <td><span class="truncate" title="${esc(b.special_requests ?? '')}">${esc(b.special_requests ?? b.internal_notes ?? '—')}</span></td>
    </tr>`,
    )
    .join('')}</tbody></table></div>`
}`;
}

export interface UpcomingProps {
  rows: BookingRow[];
  refs: Map<string, RefOption[]>;
  range: string;
  from: string;
  to: string;
  flash: { ok?: string; err?: string; warn?: string };
}

const RANGES: Array<[string, string]> = [
  ['today', 'Today'],
  ['tomorrow', 'Tomorrow'],
  ['7', 'Next 7 days'],
  ['30', 'Next 30 days'],
  ['custom', 'Custom range'],
];

export function upcomingPage(p: UpcomingProps): string {
  const tabs = RANGES.map(
    ([value, label]) =>
      `<a class="btn ${p.range === value ? '' : 'ghost'} sm" href="/admin/upcoming?range=${esc(value)}">${esc(label)}</a>`,
  ).join('');

  return `
<div class="page-head">
  <div>
    <div class="kicker">CHFR Operations</div>
    <h1>Upcoming</h1>
    <p class="sub">${esc(formatLongDate(p.from))} → ${esc(formatLongDate(p.to))} · ${p.rows.length} journey${p.rows.length === 1 ? '' : 's'}</p>
  </div>
  <div class="btn-row">
    <a class="btn ghost" href="/api/admin/export/bookings?scope=upcoming&format=csv">Export upcoming (CSV)</a>
    <a class="btn ghost" href="/api/admin/export/bookings?scope=upcoming&format=xlsx">Export upcoming (Excel)</a>
  </div>
</div>

${notices(p.flash)}

<div class="panel tight">
  <div class="btn-row" style="margin-bottom:${p.range === 'custom' ? '16px' : '0'}">${tabs}</div>
  ${
    p.range === 'custom'
      ? `<form method="get" action="/admin/upcoming" class="filters" style="margin:0">
           <input type="hidden" name="range" value="custom">
           <div class="field"><label for="from">From</label><input id="from" type="date" name="from" value="${esc(p.from)}"></div>
           <div class="field"><label for="to">To</label><input id="to" type="date" name="to" value="${esc(p.to)}"></div>
           <div class="field"><label>&nbsp;</label><button class="btn sm" type="submit">Apply</button></div>
         </form>`
      : ''
  }
</div>

${
  p.rows.length === 0
    ? `<div class="empty">No journeys in this period.</div>`
    : `<div class="table-scroll"><table>
  <thead><tr>
    <th class="nowrap">Date</th><th class="nowrap">Time</th><th>Booking</th><th>Customer</th>
    <th>Pickup</th><th>Destination</th><th>Vehicle</th><th class="nowrap">Pax</th>
    <th>Driver</th><th>Status</th>
  </tr></thead>
  <tbody>${p.rows
    .map(
      (b) => `<tr>
      <td class="nowrap">${esc(formatLongDate(b.journey_date))}</td>
      <td class="nowrap"><strong>${esc(formatTime(b.pickup_time))}</strong></td>
      <td class="nowrap"><a class="ref" href="/admin/bookings/${esc(b.id)}">${esc(b.booking_reference)}</a></td>
      <td class="nowrap">${esc(b.full_name)}<span class="muted">${esc(b.mobile)}</span></td>
      <td><span class="truncate" title="${esc(b.pickup_location)}">${esc(b.pickup_location)}</span></td>
      <td><span class="truncate" title="${esc(b.destination)}">${esc(b.destination)}</span></td>
      <td class="nowrap">${esc(labelOf(p.refs, 'vehicle', b.preferred_vehicle))}</td>
      <td class="nowrap">${b.passengers}</td>
      <td class="nowrap">${esc(b.driver_name ?? '—')}</td>
      <td class="nowrap">${statusBadge(p.refs, b.status)}</td>
    </tr>`,
    )
    .join('')}</tbody></table></div>`
}`;
}

function labelOf(refs: Map<string, RefOption[]>, category: string, code: string): string {
  return (refs.get(category) ?? []).find((o) => o.code === code)?.label ?? code;
}
