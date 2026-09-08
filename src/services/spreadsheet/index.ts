import { config } from '../../config/env.js';
import { GoogleSheetsProvider } from './google.js';
import type { SpreadsheetProvider, SyncResult } from './provider.js';

export type { SpreadsheetProvider, SyncResult } from './provider.js';
export { SHEET_COLUMNS, SHEET_HEADERS, bookingToRow } from './columns.js';

/**
 * Used when no live spreadsheet is configured. The dashboard's CSV/XLSX export
 * is always available, so this is a perfectly serviceable production setup for
 * a small operation — it just means the sheet is pulled, not pushed.
 */
export class NoopSpreadsheetProvider implements SpreadsheetProvider {
  readonly name = 'none';
  readonly configured = false;

  async upsertBooking(): Promise<SyncResult> {
    return { ok: false, skipped: true, error: 'No live spreadsheet configured — use the dashboard export' };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: 'Not configured' };
  }
}

let provider: SpreadsheetProvider | undefined;

export function spreadsheetProvider(): SpreadsheetProvider {
  if (!provider) {
    provider = config.SPREADSHEET_PROVIDER === 'google' ? new GoogleSheetsProvider() : new NoopSpreadsheetProvider();
  }
  return provider;
}

export function setSpreadsheetProvider(next: SpreadsheetProvider | undefined): void {
  provider = next;
}
