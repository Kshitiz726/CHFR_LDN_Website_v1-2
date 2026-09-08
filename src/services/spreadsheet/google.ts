import { sheets, type sheets_v4 } from '@googleapis/sheets';
import { JWT } from 'google-auth-library';
import { config } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type { BookingRow } from '../../domain/booking.js';
import type { RefOption } from '../../domain/refOptions.js';
import { SHEET_HEADERS, bookingToRow } from './columns.js';
import type { SpreadsheetProvider, SyncResult } from './provider.js';

/**
 * Google Sheets as the live operational spreadsheet.
 *
 * The database stays the source of truth: this appends or rewrites a single row
 * per booking, keyed by Booking Reference, so a booking never appears twice and
 * a staff edit in the admin dashboard overwrites the row rather than adding one.
 */
export class GoogleSheetsProvider implements SpreadsheetProvider {
  readonly name = 'google-sheets';
  private client: sheets_v4.Sheets | undefined;

  get configured(): boolean {
    return Boolean(
      config.SPREADSHEET_PROVIDER === 'google' &&
        config.GOOGLE_SHEETS_ID &&
        config.GOOGLE_SERVICE_ACCOUNT_JSON,
    );
  }

  private api(): sheets_v4.Sheets {
    if (this.client) return this.client;

    const raw = config.GOOGLE_SERVICE_ACCOUNT_JSON!;
    // The key may be supplied as raw JSON or base64 (easier to paste into a
    // Render environment variable without newline mangling).
    const json = raw.trim().startsWith('{')
      ? raw
      : Buffer.from(raw, 'base64').toString('utf8');

    let credentials: { client_email: string; private_key: string };
    try {
      credentials = JSON.parse(json);
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON or base64-encoded JSON');
    }

    const auth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    this.client = sheets({ version: 'v4', auth });
    return this.client;
  }

  private get tab(): string {
    return config.GOOGLE_SHEETS_TAB;
  }

  private get sheetId(): string {
    return config.GOOGLE_SHEETS_ID!;
  }

  /** Creates the tab if missing and makes sure row 1 holds the current headers. */
  private async ensureSheet(): Promise<void> {
    const api = this.api();
    const meta = await api.spreadsheets.get({ spreadsheetId: this.sheetId });
    const exists = meta.data.sheets?.some((s) => s.properties?.title === this.tab);

    if (!exists) {
      await api.spreadsheets.batchUpdate({
        spreadsheetId: this.sheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: this.tab, gridProperties: { frozenRowCount: 1 } } } }] },
      });
    }

    const header = await api.spreadsheets.values.get({
      spreadsheetId: this.sheetId,
      range: `${this.tab}!1:1`,
    });

    const current = header.data.values?.[0] ?? [];
    const matches = SHEET_HEADERS.every((h, i) => current[i] === h);
    if (!matches) {
      await api.spreadsheets.values.update({
        spreadsheetId: this.sheetId,
        range: `${this.tab}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [SHEET_HEADERS] },
      });
    }
  }

  /** Row number (1-based, including the header) for a booking reference. */
  private async findRow(reference: string): Promise<number | null> {
    const res = await this.api().spreadsheets.values.get({
      spreadsheetId: this.sheetId,
      range: `${this.tab}!A:A`,
    });
    const column = res.data.values ?? [];
    for (let i = 1; i < column.length; i += 1) {
      if (column[i]?.[0] === reference) return i + 1;
    }
    return null;
  }

  async upsertBooking(booking: BookingRow, refs: Map<string, RefOption[]>): Promise<SyncResult> {
    if (!this.configured) return { ok: false, skipped: true, error: 'Google Sheets is not configured' };

    try {
      await this.ensureSheet();
      const values = [bookingToRow(booking, refs)];
      const existingRow = await this.findRow(booking.booking_reference);

      if (existingRow) {
        await this.api().spreadsheets.values.update({
          spreadsheetId: this.sheetId,
          range: `${this.tab}!A${existingRow}`,
          valueInputOption: 'RAW',
          requestBody: { values },
        });
        return { ok: true, rowNumber: existingRow };
      }

      const appended = await this.api().spreadsheets.values.append({
        spreadsheetId: this.sheetId,
        range: `${this.tab}!A1`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values },
      });

      // updatedRange looks like "Bookings!A42:AC42" — pull the row number out.
      const range = appended.data.updates?.updatedRange ?? '';
      const rowNumber = Number(range.match(/!\D+(\d+)/)?.[1] ?? 0) || undefined;
      return { ok: true, rowNumber };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ reference: booking.booking_reference, error: message }, 'Google Sheets sync failed');
      return { ok: false, error: message };
    }
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    if (!this.configured) return { ok: false, error: 'Not configured' };
    try {
      await this.api().spreadsheets.get({ spreadsheetId: this.sheetId, fields: 'spreadsheetId' });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
