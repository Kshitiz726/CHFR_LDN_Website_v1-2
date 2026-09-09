import { esc, escMultiline } from '../../utils/html.js';
import { formatDateTime, formatLongDate, formatTime } from '../../utils/dates.js';
import type { BookingRow, BookingEventRow } from '../../domain/booking.js';
import type { RefOption } from '../../domain/refOptions.js';
import type { UserRow } from '../../repositories/users.js';
import type { NotificationLogRow, WhatsAppMessageRow } from '../../repositories/notifications.js';
import {
  statusBadge, priorityBadge, refSelect, textField, textArea,
  selectField, csrfInput, notices, money, definitionList,
} from './components.js';

export interface BookingDetailProps {
  booking: BookingRow;
  events: BookingEventRow[];
  notifications: NotificationLogRow[];
  whatsappMessages: WhatsAppMessageRow[];
  refs: Map<string, RefOption[]>;
  staff: UserRow[];
  user: UserRow;
  csrf: string;
  whatsappConfigured: boolean;
  flash: { ok?: string; err?: string; warn?: string };
}

export function bookingDetailPage(p: BookingDetailProps): string {
  const b = p.booking;
  const csrf = csrfInput(p.csrf);

  return `
<div class="page-head">
  <div>
    <div class="kicker">Booking</div>
    <h1>${esc(b.booking_reference)}</h1>
    <p class="sub">
      ${statusBadge(p.refs, b.status)} ${priorityBadge(p.refs, b.priority)}
      &nbsp;·&nbsp; Created ${esc(formatDateTime(b.created_at))}
      &nbsp;·&nbsp; Updated ${esc(formatDateTime(b.updated_at))}
      ${b.archived_at ? '&nbsp;·&nbsp; <span class="badge bad">Archived</span>' : ''}
    </p>
  </div>
  <div class="btn-row">
    <a class="btn ghost" href="/admin/bookings">Back to bookings</a>
    <a class="btn ghost" href="mailto:${esc(b.email)}?subject=${encodeURIComponent(`CHFR LDN booking ${b.booking_reference}`)}">Email customer</a>
    <a class="btn" href="tel:${esc(b.mobile)}">Call ${esc(b.mobile)}</a>
  </div>
</div>

${notices(p.flash)}

<div class="btn-row" style="margin-bottom:22px">
  <button class="btn ghost sm" type="button" data-copy="${esc(b.mobile)}">Copy phone</button>
  <button class="btn ghost sm" type="button" data-copy="${esc(b.email)}">Copy email</button>
  <button class="btn ghost sm" type="button" data-copy="${esc(b.booking_reference)}">Copy reference</button>
  <form method="post" action="/admin/bookings/${esc(b.id)}/contacted" style="display:inline">
    ${csrf}<button class="btn ghost sm" type="submit">Mark contacted</button>
  </form>
  ${
    p.whatsappConfigured
      ? `<a class="btn ghost sm" href="#whatsapp">WhatsApp customer</a>`
      : `<span class="badge" title="Set WHATSAPP_ENABLED and the OPENWA_* variables to enable">WhatsApp off</span>`
  }
</div>

${bookedPanel(b, csrf)}

<div class="detail-grid">
  <div>
    <!-- ------------------------------------------------------- edit form -->
    <section class="panel">
      <div class="section-title">Edit booking</div>
      <form method="post" action="/admin/bookings/${esc(b.id)}">
        ${csrf}
        <div class="form-grid">
          ${textField({ name: 'full_name', label: 'Customer name', value: b.full_name, required: true })}
          ${textField({ name: 'mobile', label: 'Mobile', value: b.mobile, type: 'tel', required: true })}
          ${textField({ name: 'email', label: 'Email', value: b.email, type: 'email', required: true, className: 'full' })}
          ${textField({ name: 'pickup_location', label: 'Pickup', value: b.pickup_location, required: true, className: 'full' })}
          ${textField({ name: 'destination', label: 'Destination', value: b.destination, required: true, className: 'full' })}
          ${textField({ name: 'journey_date', label: 'Journey date', value: b.journey_date, type: 'date', required: true })}
          ${textField({ name: 'pickup_time', label: 'Pickup time', value: formatTime(b.pickup_time), type: 'time', required: true })}
          ${textField({ name: 'passengers', label: 'Passengers', value: b.passengers, type: 'number', min: '1', max: '16' })}
          ${refSelect(p.refs, 'luggage', { name: 'luggage', label: 'Luggage', value: b.luggage })}
          ${refSelect(p.refs, 'journey_type', { name: 'journey_type', label: 'Journey type', value: b.journey_type })}
          ${refSelect(p.refs, 'vehicle', { name: 'preferred_vehicle', label: 'Vehicle', value: b.preferred_vehicle })}
          ${textField({ name: 'flight_number', label: 'Flight number', value: b.flight_number })}
          ${textField({ name: 'vehicle_registration', label: 'Vehicle registration', value: b.vehicle_registration })}
          ${textArea({ name: 'special_requests', label: 'Special requests', value: b.special_requests, rows: 3, className: 'full' })}

          ${refSelect(p.refs, 'status', { name: 'status', label: 'Status', value: b.status })}
          ${refSelect(p.refs, 'priority', { name: 'priority', label: 'Priority', value: b.priority })}
          ${selectField({
            name: 'assigned_to',
            label: 'Assigned to',
            includeBlank: 'Unassigned',
            value: b.assigned_to,
            options: p.staff.map((s) => ({ value: s.id, label: `${s.name} (${s.role})` })),
          })}
          ${textField({ name: 'driver_name', label: 'Driver', value: b.driver_name })}

          ${textField({ name: 'quoted_price', label: 'Quoted price', value: b.quoted_price ?? '', type: 'number', step: '0.01', min: '0' })}
          ${textField({ name: 'confirmed_price', label: 'Confirmed price', value: b.confirmed_price ?? '', type: 'number', step: '0.01', min: '0' })}
          ${textField({ name: 'currency', label: 'Currency', value: b.currency })}
          ${refSelect(p.refs, 'payment_status', { name: 'payment_status', label: 'Payment status', value: b.payment_status })}

          ${textArea({ name: 'internal_notes', label: 'Internal notes (never sent to the customer)', value: b.internal_notes, rows: 4, className: 'full' })}
          ${textArea({ name: 'customer_notes', label: 'Customer notes', value: b.customer_notes, rows: 3, className: 'full' })}
        </div>

        <label class="checkline" style="margin:18px 0 20px">
          <input type="checkbox" name="skip_customer_email" value="on">
          <span><strong>Do not email the customer this time.</strong> By default the customer is
          emailed automatically whenever you change something they need to know: status, pickup,
          destination, date, time, vehicle, confirmed price, driver, registration or customer notes.
          Internal notes, priority and the assignee never trigger an email.</span>
        </label>

        <div class="btn-row">
          <button class="btn" type="submit">Save changes</button>
        </div>
      </form>
    </section>

    <!-- ---------------------------------------------------------- notes -->
    <section class="panel">
      <div class="section-title">Add a note</div>
      <form method="post" action="/admin/bookings/${esc(b.id)}/notes">
        ${csrf}
        <textarea name="note" rows="3" placeholder="Add a note to this booking's history…" required></textarea>
        <div class="btn-row" style="margin-top:12px">
          <button class="btn ghost" type="submit">Add note</button>
        </div>
      </form>
    </section>

    <!-- ------------------------------------------------------- whatsapp -->
    <section class="panel" id="whatsapp">
      <div class="section-title">WhatsApp the customer</div>
      ${
        p.whatsappConfigured
          ? `<form method="post" action="/admin/bookings/${esc(b.id)}/whatsapp"
                   data-confirm="Send this WhatsApp message to ${esc(b.full_name)} on ${esc(b.mobile)}?">
              ${csrf}
              <input type="hidden" name="confirm" value="yes">
              <textarea name="message" rows="4" required>Hi ${esc(firstName(b.full_name))}, this is CHFR LDN regarding booking ${esc(b.booking_reference)}. </textarea>
              <div class="btn-row" style="margin-top:12px">
                <button class="btn ghost" type="submit">Send WhatsApp to ${esc(b.mobile)}</button>
              </div>
            </form>`
          : `<p class="sub" style="margin:0">WhatsApp is not configured. Set <code>WHATSAPP_ENABLED=true</code>
             and the <code>OPENWA_*</code> variables to enable sending from here.</p>`
      }
      ${
        p.whatsappMessages.length
          ? `<div style="margin-top:20px">
               <div class="flabel" style="margin-bottom:10px">Message history</div>
               <div class="table-scroll scroll-y"><table style="min-width:0">
                 <thead><tr><th class="nowrap">When</th><th>Status</th><th>Message</th></tr></thead>
                 <tbody>${p.whatsappMessages
                   .map(
                     (m) => `<tr>
                       <td class="nowrap">${esc(formatDateTime(m.created_at))}</td>
                       <td class="nowrap"><span class="badge ${m.status === 'SENT' ? 'good' : m.status === 'SKIPPED' ? 'done' : 'bad'}">${esc(m.status)}</span></td>
                       <td><span class="truncate" title="${esc(m.body)}">${esc(m.body)}</span>
                       ${m.error_message ? `<span class="muted">${esc(m.error_message)}</span>` : ''}</td>
                     </tr>`,
                   )
                   .join('')}</tbody>
               </table></div>
             </div>`
          : ''
      }
    </section>
  </div>

  <div>
    <!-- --------------------------------------------------------- summary -->
    <section class="panel">
      <div class="section-title">Customer</div>
      ${definitionList([
        ['Name', esc(b.full_name)],
        ['Mobile', `<a href="tel:${esc(b.mobile)}">${esc(b.mobile)}</a>`],
        ['Email', `<a href="mailto:${esc(b.email)}">${esc(b.email)}</a>`],
        ['Source', esc(b.source === 'WEBSITE' ? 'Website' : b.source)],
        ['Last contacted', esc(b.last_contacted_at ? formatDateTime(b.last_contacted_at) : 'Not yet contacted')],
      ])}
    </section>

    <section class="panel">
      <div class="section-title">Journey</div>
      ${definitionList([
        ['Pickup', esc(b.pickup_location)],
        ['Destination', esc(b.destination)],
        ['Date', esc(formatLongDate(b.journey_date))],
        ['Pickup time', esc(formatTime(b.pickup_time))],
        ['Passengers', String(b.passengers)],
        ['Luggage', esc(labelOf(p.refs, 'luggage', b.luggage))],
        ['Journey type', esc(labelOf(p.refs, 'journey_type', b.journey_type))],
        ['Flight number', esc(b.flight_number ?? '—')],
      ])}
    </section>

    <section class="panel">
      <div class="section-title">Vehicle</div>
      ${definitionList([
        ['Preferred vehicle', esc(labelOf(p.refs, 'vehicle', b.preferred_vehicle))],
        ['Driver', esc(b.driver_name ?? '—')],
        ['Registration', esc(b.vehicle_registration ?? '—')],
      ])}
    </section>

    <section class="panel">
      <div class="section-title">Pricing</div>
      ${definitionList([
        ['Quoted', esc(money(b.quoted_price, b.currency))],
        ['Confirmed', esc(money(b.confirmed_price, b.currency))],
        ['Currency', esc(b.currency)],
        ['Payment status', esc(labelOf(p.refs, 'payment_status', b.payment_status))],
      ])}
      <p class="sub" style="margin-top:14px;font-size:11.5px">
        CHFR never requests card details online. Pricing is confirmed with the customer directly.
      </p>
    </section>

    ${
      b.special_requests
        ? `<section class="panel">
             <div class="section-title">Special requests</div>
             <div style="font-size:13px;line-height:1.7;color:#dcdcdc">${escMultiline(b.special_requests)}</div>
           </section>`
        : ''
    }

    ${
      b.internal_notes
        ? `<section class="panel">
             <div class="section-title">Internal notes</div>
             <div style="font-size:13px;line-height:1.7;color:#dcdcdc">${escMultiline(b.internal_notes)}</div>
           </section>`
        : ''
    }

    <!-- --------------------------------------------------- communication -->
    <section class="panel">
      <div class="section-title">Communication</div>
      ${definitionList([
        ['Internal email', deliveryChip(b.internal_email_sent)],
        ['Customer email', deliveryChip(b.customer_email_sent)],
        ['WhatsApp', `<span class="badge ${b.whatsapp_status === 'SENT' ? 'good' : b.whatsapp_status === 'SKIPPED' ? 'done' : b.whatsapp_status === 'PENDING' ? '' : 'bad'}">${esc(b.whatsapp_status)}</span>`],
        ['Spreadsheet', `<span class="badge ${b.sheet_status === 'SYNCED' ? 'good' : b.sheet_status === 'SKIPPED' ? 'done' : b.sheet_status === 'PENDING' ? '' : 'bad'}">${esc(b.sheet_status)}</span>`],
      ])}

      <div class="btn-row" style="margin-top:16px">
        <form method="post" action="/admin/bookings/${esc(b.id)}/retry/internal-email" style="display:inline">
          ${csrf}<button class="btn ghost sm" type="submit">Resend internal email</button>
        </form>
        <form method="post" action="/admin/bookings/${esc(b.id)}/retry/customer-email" style="display:inline">
          ${csrf}<button class="btn ghost sm" type="submit">Resend customer email</button>
        </form>
        <form method="post" action="/admin/bookings/${esc(b.id)}/retry/whatsapp" style="display:inline">
          ${csrf}<button class="btn ghost sm" type="submit">Send WhatsApp again</button>
        </form>
        <form method="post" action="/admin/bookings/${esc(b.id)}/retry/spreadsheet" style="display:inline">
          ${csrf}<button class="btn ghost sm" type="submit">Resync spreadsheet</button>
        </form>
      </div>

      ${
        p.notifications.length
          ? `<div class="table-scroll scroll-y" style="margin-top:18px"><table style="min-width:0">
               <thead><tr><th>Channel</th><th>Status</th><th class="nowrap">Attempts</th><th class="nowrap">When</th></tr></thead>
               <tbody>${p.notifications
                 .map(
                   (n) => `<tr>
                     <td class="nowrap">${esc(n.channel)}<span class="muted">${esc(n.kind)}</span></td>
                     <td class="nowrap"><span class="badge ${n.status === 'SENT' ? 'good' : n.status === 'SKIPPED' ? 'done' : n.status === 'PENDING' ? '' : 'bad'}">${esc(n.status)}</span>
                       ${n.error_message ? `<span class="muted" title="${esc(n.error_message)}">${esc(n.error_message.slice(0, 60))}</span>` : ''}</td>
                     <td class="nowrap">${n.attempts}</td>
                     <td class="nowrap">${esc(formatDateTime(n.sent_at ?? n.created_at))}</td>
                   </tr>`,
                 )
                 .join('')}</tbody>
             </table></div>`
          : ''
      }
    </section>

    <!-- ----------------------------------------------------- audit trail -->
    <section class="panel">
      <div class="section-title">Audit history</div>
      <ul class="timeline scroll-y">
        ${
          p.events.length === 0
            ? '<li><div class="what">No history yet.</div></li>'
            : p.events
                .map(
                  (e) => `<li>
                    <div class="when">${esc(formatDateTime(e.created_at))}</div>
                    <div class="what">${esc(e.message ?? humanEvent(e.event_type))}</div>
                    ${
                      e.old_value !== null || e.new_value !== null
                        ? `<div class="change">${esc(e.old_value ?? '—')} → ${esc(e.new_value ?? '—')}</div>`
                        : ''
                    }
                    <div class="who">${esc(e.changed_by_label)}</div>
                  </li>`,
                )
                .join('')
        }
      </ul>
      <p class="sub" style="margin-top:14px;font-size:11.5px">
        History is append-only and cannot be edited or removed from this dashboard.
      </p>
    </section>

    <!-- --------------------------------------------------------- danger -->
    <section class="panel">
      <div class="section-title">Record</div>
      ${
        b.archived_at
          ? `<form method="post" action="/admin/bookings/${esc(b.id)}/restore">
               ${csrf}<button class="btn ghost sm" type="submit">Restore from archive</button>
             </form>`
          : `<form method="post" action="/admin/bookings/${esc(b.id)}/archive"
                   data-confirm="Archive ${esc(b.booking_reference)}? It stays in the database and keeps its history.">
               ${csrf}<button class="btn danger sm" type="submit">Archive booking</button>
             </form>`
      }
      ${
        p.user.role === 'ADMIN'
          ? `<form method="post" action="/admin/bookings/${esc(b.id)}/delete" style="margin-top:10px"
                   data-confirm="Permanently delete ${esc(b.booking_reference)} and its entire history? This cannot be undone.">
               ${csrf}<button class="btn danger sm" type="submit">Delete permanently (GDPR erasure)</button>
             </form>
             <p class="sub" style="margin-top:12px;font-size:11.5px">
               Permanent deletion is for a verified erasure request. Archive is the normal action.
             </p>`
          : ''
      }
    </section>
  </div>
</div>`;
}

function deliveryChip(sent: boolean): string {
  return `<span class="badge ${sent ? 'good' : 'bad'}">${sent ? 'Sent' : 'Not sent'}</span>`;
}

function labelOf(refs: Map<string, RefOption[]>, category: string, code: string): string {
  return (refs.get(category) ?? []).find((o) => o.code === code)?.label ?? code;
}

function humanEvent(type: string): string {
  return type.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

function firstName(full: string): string {
  return (full ?? '').trim().split(/\s+/)[0] ?? '';
}

/**
 * The one-click "tell the customer they are booked" action.
 *
 * It names the details that will actually be in the email, and says plainly
 * which of them are still blank, so nobody sends a confirmation that reads as
 * half-finished. The button still works with them blank: sometimes the car is
 * allocated later and the customer just needs to know the journey is on.
 */
function bookedPanel(b: BookingRow, csrf: string): string {
  const missing = [
    b.driver_name ? null : 'chauffeur',
    b.vehicle_registration ? null : 'vehicle registration',
    (b.confirmed_price ?? b.quoted_price) ? null : 'price',
  ].filter((x): x is string => x !== null);

  const already = b.status === 'CONFIRMED';

  return `
<section class="panel" style="margin-bottom:22px">
  <div class="section-title">Confirm to the customer</div>
  <div style="font-size:13px;line-height:1.7;color:#dcdcdc">
    Sends ${esc(b.full_name)} a short email: the journey is booked, their chauffeur will be at
    <strong>${esc(b.pickup_location)}</strong> at <strong>${esc(formatTime(b.pickup_time))}</strong>
    on <strong>${esc(formatLongDate(b.journey_date))}</strong>, with the vehicle, chauffeur and
    agreed price.${already ? '' : ' It also marks this booking as Confirmed.'}
  </div>
  ${
    missing.length
      ? `<div class="badge" style="margin-top:12px">Not filled in yet: ${esc(missing.join(', '))}. Those lines are left out of the email.</div>`
      : ''
  }
  <div class="btn-row" style="margin-top:16px">
    <form method="post" action="/admin/bookings/${esc(b.id)}/booked" style="display:inline">
      ${csrf}<button class="btn" type="submit">Send booked confirmation</button>
    </form>
  </div>
</section>`;
}
