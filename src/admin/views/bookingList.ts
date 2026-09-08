import { esc } from '../../utils/html.js';
import { formatDateTime, formatLongDate, formatTime } from '../../utils/dates.js';
import type { BookingRow } from '../../domain/booking.js';
import type { RefOption } from '../../domain/refOptions.js';
import type { UserRow } from '../../repositories/users.js';
import { statusBadge, money, notices } from './components.js';

export interface BookingListProps {
  rows: BookingRow[];
  total: number;
  refs: Map<string, RefOption[]>;
  staff: UserRow[];
  query: Record<string, string>;
  page: number;
  pageSize: number;
  flash: { ok?: string; err?: string; warn?: string };
}

const SORT_OPTIONS = [
  ['newest', 'Newest first'],
  ['journey_date', 'Journey date (soonest)'],
  ['journey_date_desc', 'Journey date (latest)'],
  ['updated', 'Recently updated'],
  ['oldest', 'Oldest first'],
];

export function bookingListPage(p: BookingListProps): string {
  const q = p.query;
  const qs = (overrides: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...q, ...overrides })) {
      if (v !== undefined && v !== '' && k !== 'page') params.set(k, String(v));
    }
    const page = overrides.page ?? q.page;
    if (page && Number(page) > 1) params.set('page', String(page));
    const s = params.toString();
    return s ? `?${s}` : '';
  };

  const opt = (list: Array<{ code: string; label: string }>, selected: string) =>
    list.map((o) => `<option value="${esc(o.code)}"${selected === o.code ? ' selected' : ''}>${esc(o.label)}</option>`).join('');

  const totalPages = Math.max(1, Math.ceil(p.total / p.pageSize));
  const from = p.total === 0 ? 0 : (p.page - 1) * p.pageSize + 1;
  const to = Math.min(p.page * p.pageSize, p.total);

  return `
<div class="page-head">
  <div>
    <div class="kicker">CHFR Operations</div>
    <h1>Bookings</h1>
    <p class="sub">${p.total} booking${p.total === 1 ? '' : 's'} match your filters</p>
  </div>
  <div class="btn-row">
    <a class="btn ghost" href="/api/admin/export/bookings${qs({ format: 'csv' })}">Export CSV</a>
    <a class="btn ghost" href="/api/admin/export/bookings${qs({ format: 'xlsx' })}">Export Excel</a>
  </div>
</div>

${notices(p.flash)}

<form class="panel tight" method="get" action="/admin/bookings" data-autosubmit>
  <div class="filters">
    <div class="field grow">
      <label for="q">Search</label>
      <input id="q" type="text" name="q" value="${esc(q.q ?? '')}"
             placeholder="Booking ref, name, phone, email, pickup or destination">
    </div>
    <div class="field">
      <label for="status">Status</label>
      <select id="status" name="status"><option value="">All statuses</option>${opt(p.refs.get('status') ?? [], q.status ?? '')}</select>
    </div>
    <div class="field">
      <label for="journey_type">Journey type</label>
      <select id="journey_type" name="journey_type"><option value="">All types</option>${opt(p.refs.get('journey_type') ?? [], q.journey_type ?? '')}</select>
    </div>
    <div class="field">
      <label for="vehicle">Vehicle</label>
      <select id="vehicle" name="vehicle"><option value="">All vehicles</option>${opt(p.refs.get('vehicle') ?? [], q.vehicle ?? '')}</select>
    </div>
    <div class="field">
      <label for="assigned_to">Assigned</label>
      <select id="assigned_to" name="assigned_to">
        <option value="">Anyone</option>
        <option value="unassigned"${q.assigned_to === 'unassigned' ? ' selected' : ''}>Unassigned</option>
        ${p.staff.map((s) => `<option value="${esc(s.id)}"${q.assigned_to === s.id ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label for="date_from">Journey from</label>
      <input id="date_from" type="date" name="date_from" value="${esc(q.date_from ?? '')}">
    </div>
    <div class="field">
      <label for="date_to">Journey to</label>
      <input id="date_to" type="date" name="date_to" value="${esc(q.date_to ?? '')}">
    </div>
    <div class="field">
      <label for="sort">Sort</label>
      <select id="sort" name="sort">
        ${SORT_OPTIONS.map(([v, l]) => `<option value="${esc(v!)}"${(q.sort ?? 'newest') === v ? ' selected' : ''}>${esc(l!)}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label for="archived">Archive</label>
      <select id="archived" name="archived">
        <option value="">Active only</option>
        <option value="include"${q.archived === 'include' ? ' selected' : ''}>Include archived</option>
        <option value="only"${q.archived === 'only' ? ' selected' : ''}>Archived only</option>
      </select>
    </div>
    <div class="field">
      <label>&nbsp;</label>
      <div class="btn-row">
        <button class="btn sm" type="submit">Apply</button>
        <a class="btn ghost sm" href="/admin/bookings">Reset</a>
      </div>
    </div>
  </div>
</form>

${
  p.rows.length === 0
    ? `<div class="empty">No bookings match these filters.</div>`
    : `<div class="table-scroll"><table>
  <thead><tr>
    <th>Booking ref</th><th class="nowrap">Created</th><th>Customer</th>
    <th>Contact</th><th>Journey</th><th class="nowrap">Journey date</th>
    <th>Type</th><th>Vehicle</th><th class="nowrap">Pax</th><th>Status</th>
    <th class="nowrap">Quoted</th><th>Payment</th><th>Assigned</th>
    <th class="nowrap">Updated</th><th>Actions</th>
  </tr></thead>
  <tbody>
  ${p.rows
    .map(
      (b) => `<tr>
    <td class="nowrap">
      <a class="ref" href="/admin/bookings/${esc(b.id)}">${esc(b.booking_reference)}</a>
      ${b.archived_at ? '<span class="muted">Archived</span>' : ''}
    </td>
    <td class="nowrap">${esc(formatDateTime(b.created_at))}</td>
    <td><span class="truncate">${esc(b.full_name)}</span></td>
    <td class="nowrap">${esc(b.mobile)}<span class="muted">${esc(b.email)}</span></td>
    <td><span class="truncate" title="${esc(b.pickup_location)}">${esc(b.pickup_location)}</span>
        <span class="muted">→ ${esc(b.destination)}</span></td>
    <td class="nowrap">${esc(formatLongDate(b.journey_date))}<span class="muted">${esc(formatTime(b.pickup_time))}</span></td>
    <td class="nowrap">${esc(label(p.refs, 'journey_type', b.journey_type))}</td>
    <td class="nowrap">${esc(label(p.refs, 'vehicle', b.preferred_vehicle))}</td>
    <td class="nowrap">${b.passengers}</td>
    <td class="nowrap">${statusBadge(p.refs, b.status)}</td>
    <td class="nowrap">${esc(money(b.quoted_price, b.currency))}</td>
    <td class="nowrap">${esc(label(p.refs, 'payment_status', b.payment_status))}</td>
    <td class="nowrap">${esc(b.assigned_to_name ?? '—')}</td>
    <td class="nowrap">${esc(formatDateTime(b.updated_at))}</td>
    <td class="nowrap"><a class="btn ghost sm" href="/admin/bookings/${esc(b.id)}">Open</a></td>
  </tr>`,
    )
    .join('')}
  </tbody>
</table></div>

<div class="pager">
  <span>Showing ${from}–${to} of ${p.total}</span>
  <span class="links">
    ${p.page > 1 ? `<a class="btn ghost sm" href="/admin/bookings${qs({ page: p.page - 1 })}">Previous</a>` : ''}
    <span style="align-self:center">Page ${p.page} of ${totalPages}</span>
    ${p.page < totalPages ? `<a class="btn ghost sm" href="/admin/bookings${qs({ page: p.page + 1 })}">Next</a>` : ''}
  </span>
</div>`
}`;
}

function label(refs: Map<string, RefOption[]>, category: string, code: string): string {
  return (refs.get(category) ?? []).find((o) => o.code === code)?.label ?? code;
}
