import type { BookingRow } from '../../domain/booking.js';
import { labelFromMap, type RefOption } from '../../domain/refOptions.js';
import { formatDateTime, formatLongDate, formatTime } from '../../utils/dates.js';

/**
 * The single definition of the spreadsheet shape, shared by the Google Sheets
 * sync, the CSV export and the XLSX export — so all three always agree.
 */

export interface SheetColumn {
  header: string;
  /** Numbers stay numbers so Excel can total a price column. */
  type: 'text' | 'number' | 'date';
  width: number;
  value: (b: BookingRow, refs: Map<string, RefOption[]>) => string | number | null;
}

const nn = (v: string | null | undefined) => (v && v.trim() ? v : '');

export const SHEET_COLUMNS: SheetColumn[] = [
  { header: 'Booking Ref',        type: 'text',   width: 20, value: (b) => b.booking_reference },
  { header: 'Created Date',       type: 'text',   width: 20, value: (b) => formatDateTime(b.created_at) },
  { header: 'Updated Date',       type: 'text',   width: 20, value: (b) => formatDateTime(b.updated_at) },
  { header: 'Status',             type: 'text',   width: 18, value: (b, r) => labelFromMap(r, 'status', b.status) },
  { header: 'Priority',           type: 'text',   width: 12, value: (b, r) => labelFromMap(r, 'priority', b.priority) },
  { header: 'Assigned To',        type: 'text',   width: 18, value: (b) => nn(b.assigned_to_name) },
  { header: 'Customer Name',      type: 'text',   width: 24, value: (b) => b.full_name },
  { header: 'Mobile',             type: 'text',   width: 18, value: (b) => b.mobile },
  { header: 'Email',              type: 'text',   width: 28, value: (b) => b.email },
  { header: 'Pickup',             type: 'text',   width: 34, value: (b) => b.pickup_location },
  { header: 'Destination',        type: 'text',   width: 34, value: (b) => b.destination },
  { header: 'Journey Date',       type: 'text',   width: 20, value: (b) => formatLongDate(b.journey_date) },
  { header: 'Pickup Time',        type: 'text',   width: 12, value: (b) => formatTime(b.pickup_time) },
  { header: 'Passengers',         type: 'number', width: 12, value: (b) => b.passengers },
  { header: 'Luggage',            type: 'text',   width: 18, value: (b, r) => labelFromMap(r, 'luggage', b.luggage) },
  { header: 'Journey Type',       type: 'text',   width: 24, value: (b, r) => labelFromMap(r, 'journey_type', b.journey_type) },
  { header: 'Preferred Vehicle',  type: 'text',   width: 24, value: (b, r) => labelFromMap(r, 'vehicle', b.preferred_vehicle) },
  { header: 'Flight Number',      type: 'text',   width: 14, value: (b) => nn(b.flight_number) },
  { header: 'Special Requests',   type: 'text',   width: 40, value: (b) => nn(b.special_requests) },
  { header: 'Quoted Price',       type: 'number', width: 14, value: (b) => b.quoted_price ?? null },
  { header: 'Confirmed Price',    type: 'number', width: 16, value: (b) => b.confirmed_price ?? null },
  { header: 'Currency',           type: 'text',   width: 10, value: (b) => b.currency },
  { header: 'Payment Status',     type: 'text',   width: 16, value: (b, r) => labelFromMap(r, 'payment_status', b.payment_status) },
  { header: 'Driver',             type: 'text',   width: 20, value: (b) => nn(b.driver_name) },
  { header: 'Vehicle Registration', type: 'text', width: 18, value: (b) => nn(b.vehicle_registration) },
  { header: 'Last Contacted',     type: 'text',   width: 20, value: (b) => (b.last_contacted_at ? formatDateTime(b.last_contacted_at) : '') },
  { header: 'Email Status',       type: 'text',   width: 16, value: (b) => (b.internal_email_sent ? 'SENT' : 'NOT SENT') },
  { header: 'WhatsApp Status',    type: 'text',   width: 16, value: (b) => b.whatsapp_status },
  { header: 'Internal Notes',     type: 'text',   width: 40, value: (b) => nn(b.internal_notes) },
];

export const SHEET_HEADERS = SHEET_COLUMNS.map((c) => c.header);

export function bookingToRow(b: BookingRow, refs: Map<string, RefOption[]>): Array<string | number | null> {
  return SHEET_COLUMNS.map((c) => {
    const value = c.value(b, refs);
    if (value === null || value === undefined) return c.type === 'number' ? null : '';
    // Collapse newlines so a multi-line note never breaks a CSV row or a cell.
    return typeof value === 'string' ? value.replace(/\r?\n/g, ' / ') : value;
  });
}
