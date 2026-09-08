import ExcelJS from 'exceljs';
import type { BookingRow } from '../domain/booking.js';
import type { RefOption } from '../domain/refOptions.js';
import { SHEET_COLUMNS, SHEET_HEADERS, bookingToRow } from './spreadsheet/columns.js';

/**
 * CSV and XLSX exports. Both use the same column definitions as the Google
 * Sheets sync, so a downloaded file and the live sheet always match.
 */

function csvCell(value: string | number | null): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  // Quote when the value contains a delimiter, quote or newline.
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function bookingsToCsv(bookings: BookingRow[], refs: Map<string, RefOption[]>): string {
  const lines = [SHEET_HEADERS.map(csvCell).join(',')];
  for (const b of bookings) {
    lines.push(bookingToRow(b, refs).map(csvCell).join(','));
  }
  // A UTF-8 BOM so Excel on Windows opens the file correctly (é, £, — survive).
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export async function bookingsToXlsx(bookings: BookingRow[], refs: Map<string, RefOption[]>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CHFR LDN';
  wb.created = new Date();

  const ws = wb.addWorksheet('Bookings', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  ws.columns = SHEET_COLUMNS.map((c) => ({ header: c.header, key: c.header, width: c.width }));

  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFF5F5F5' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1C1C1C' } };
  header.alignment = { vertical: 'middle' };
  header.height = 22;

  for (const b of bookings) {
    const row = ws.addRow(bookingToRow(b, refs));
    // Prices are written as real numbers with a currency format, so staff can
    // sum a column rather than getting text.
    SHEET_COLUMNS.forEach((col, i) => {
      if (col.type === 'number' && /Price/.test(col.header)) {
        row.getCell(i + 1).numFmt = '#,##0.00';
      }
    });
  }

  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: SHEET_COLUMNS.length } };

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** Safe, dated filename for a download. */
export function exportFilename(scope: string, extension: 'csv' | 'xlsx'): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const safe = scope.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  return `chfr-bookings-${safe}-${stamp}.${extension}`;
}
