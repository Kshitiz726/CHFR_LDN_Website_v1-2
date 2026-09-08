import type { BookingRow } from '../../domain/booking.js';
import type { RefOption } from '../../domain/refOptions.js';

export interface SyncResult {
  ok: boolean;
  rowNumber?: number;
  error?: string;
  /** True when the integration is switched off rather than broken. */
  skipped?: boolean;
}

export interface SpreadsheetProvider {
  readonly name: string;
  readonly configured: boolean;
  upsertBooking(booking: BookingRow, refs: Map<string, RefOption[]>): Promise<SyncResult>;
  healthCheck(): Promise<{ ok: boolean; error?: string }>;
}
