/** Row shape returned by the booking repository (dates/times are plain strings). */
export interface BookingRow {
  id: string;
  booking_reference: string;

  full_name: string;
  mobile: string;
  email: string;

  pickup_location: string;
  destination: string;
  journey_date: string; // YYYY-MM-DD
  pickup_time: string; // HH:MM
  passengers: number;
  luggage: string;
  journey_type: string;
  preferred_vehicle: string;
  flight_number: string | null;
  special_requests: string | null;

  status: string;
  priority: string;
  assigned_to: string | null;
  assigned_to_name: string | null;
  quoted_price: number | null;
  confirmed_price: number | null;
  currency: string;
  payment_status: string;
  driver_name: string | null;
  vehicle_registration: string | null;
  internal_notes: string | null;
  customer_notes: string | null;

  customer_email_sent: boolean;
  internal_email_sent: boolean;
  whatsapp_sent: boolean;
  whatsapp_message_id: string | null;
  whatsapp_status: string;
  last_contacted_at: string | null;

  sheet_row_number: number | null;
  sheet_synced_at: string | null;
  sheet_status: string;

  source: string;
  archived_at: string | null;

  created_at: string;
  updated_at: string;
}

export interface BookingEventRow {
  id: string;
  booking_id: string;
  event_type: string;
  field: string | null;
  old_value: string | null;
  new_value: string | null;
  message: string | null;
  changed_by: string | null;
  changed_by_label: string;
  created_at: string;
}

/** Fields staff may edit, and the label used for them in the audit trail. */
export const EDITABLE_FIELDS: Record<string, string> = {
  full_name: 'Customer name',
  mobile: 'Mobile',
  email: 'Email',
  pickup_location: 'Pickup',
  destination: 'Destination',
  journey_date: 'Journey date',
  pickup_time: 'Pickup time',
  passengers: 'Passengers',
  luggage: 'Luggage',
  journey_type: 'Journey type',
  preferred_vehicle: 'Vehicle',
  flight_number: 'Flight number',
  special_requests: 'Special requests',
  status: 'Status',
  priority: 'Priority',
  assigned_to: 'Assigned to',
  quoted_price: 'Quoted price',
  confirmed_price: 'Confirmed price',
  currency: 'Currency',
  payment_status: 'Payment status',
  driver_name: 'Driver',
  vehicle_registration: 'Vehicle registration',
  internal_notes: 'Internal notes',
  customer_notes: 'Customer notes',
};

/**
 * Changes to these fields affect what the customer needs to know, so they are
 * the only ones that can trigger a customer-facing update email. Purely
 * internal edits (notes, driver allocation, pricing drafts) never do.
 */
export const CUSTOMER_IMPACTING_FIELDS = new Set([
  'pickup_location',
  'destination',
  'journey_date',
  'pickup_time',
  'preferred_vehicle',
  'status',
]);
