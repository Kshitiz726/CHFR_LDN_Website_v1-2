import { esc } from '../../../utils/html.js';

/**
 * Shared email chrome. Table-based and inline-styled, because Gmail, Outlook
 * and Apple Mail all strip <style> blocks and ignore flex/grid.
 */

const BRAND_RED = '#ff4a5e';
const INK = '#111111';
const PANEL = '#1c1c1c';

export interface Section {
  title: string;
  rows: Array<[label: string, value: string | null | undefined]>;
}

export function renderRows(rows: Section['rows']): string {
  return rows
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '')
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:7px 0;font:500 12px/1.5 Arial,Helvetica,sans-serif;color:#8d8d8d;width:170px;vertical-align:top;">${esc(label)}</td>
          <td style="padding:7px 0;font:500 14px/1.55 Arial,Helvetica,sans-serif;color:#f5f5f5;vertical-align:top;">${esc(value)}</td>
        </tr>`,
    )
    .join('');
}

export function renderSection(section: Section): string {
  const body = renderRows(section.rows);
  if (!body) return '';
  return `
    <tr><td style="padding:26px 30px 0;">
      <div style="font:700 11px/1 Arial,Helvetica,sans-serif;letter-spacing:2.2px;text-transform:uppercase;color:${BRAND_RED};padding-bottom:10px;">${esc(section.title)}</div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${body}</table>
      <div style="height:1px;background:#2c2c2c;margin-top:20px;"></div>
    </td></tr>`;
}

export function renderFreeText(title: string, text: string | null | undefined): string {
  if (!text || !text.trim()) return '';
  return `
    <tr><td style="padding:26px 30px 0;">
      <div style="font:700 11px/1 Arial,Helvetica,sans-serif;letter-spacing:2.2px;text-transform:uppercase;color:${BRAND_RED};padding-bottom:10px;">${esc(title)}</div>
      <div style="font:400 14px/1.7 Arial,Helvetica,sans-serif;color:#e2e2e2;background:#141414;border:1px solid #2c2c2c;padding:14px 16px;white-space:pre-wrap;">${esc(text)}</div>
      <div style="height:1px;background:#2c2c2c;margin-top:20px;"></div>
    </td></tr>`;
}

export function renderButton(label: string, href: string): string {
  return `
    <tr><td style="padding:28px 30px 4px;" align="left">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr><td bgcolor="${BRAND_RED}" style="border-radius:2px;">
          <a href="${esc(href)}" target="_blank"
             style="display:inline-block;padding:15px 30px;font:800 12px/1 Arial,Helvetica,sans-serif;letter-spacing:1px;text-transform:uppercase;color:${INK};text-decoration:none;">${esc(label)}</a>
        </td></tr>
      </table>
    </td></tr>`;
}

export interface LayoutOptions {
  preheader: string;
  eyebrow: string;
  heading: string;
  badge?: { label: string; value: string };
  intro?: string;
  body: string;
  footerNote?: string;
}

export function layout(opts: LayoutOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>CHFR LDN.</title>
</head>
<body style="margin:0;padding:0;background:#0c0c0c;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(opts.preheader)}</div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0c0c0c;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600"
             style="width:100%;max-width:600px;background:${PANEL};border:1px solid #2c2c2c;">

        <tr><td style="padding:30px 30px 0;">
          <div style="font:800 28px/1 Arial,Helvetica,sans-serif;letter-spacing:-1.6px;color:${BRAND_RED};">CHFR<span style="font-size:11px;letter-spacing:1.2px;color:#f5f5f5;padding-left:6px;">LDN.</span></div>
          <div style="font:700 11px/1 Arial,Helvetica,sans-serif;letter-spacing:2.4px;text-transform:uppercase;color:#8d8d8d;padding-top:22px;">${esc(opts.eyebrow)}</div>
          <div style="font:700 27px/1.2 Arial,Helvetica,sans-serif;letter-spacing:-1px;color:#f5f5f5;padding-top:8px;">${esc(opts.heading)}</div>
          ${opts.intro ? `<div style="font:400 14px/1.7 Arial,Helvetica,sans-serif;color:#b8b8b8;padding-top:14px;">${esc(opts.intro)}</div>` : ''}
        </td></tr>

        ${
          opts.badge
            ? `<tr><td style="padding:22px 30px 0;">
                 <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
                        style="background:#141414;border:1px solid ${BRAND_RED};">
                   <tr><td style="padding:16px 18px;">
                     <div style="font:700 10px/1 Arial,Helvetica,sans-serif;letter-spacing:2px;text-transform:uppercase;color:#8d8d8d;">${esc(opts.badge.label)}</div>
                     <div style="font:800 21px/1.2 Arial,Helvetica,sans-serif;letter-spacing:.5px;color:#f5f5f5;padding-top:7px;">${esc(opts.badge.value)}</div>
                   </td></tr>
                 </table>
               </td></tr>`
            : ''
        }

        ${opts.body}

        <tr><td style="padding:30px;">
          <div style="height:1px;background:#2c2c2c;"></div>
          <div style="font:700 13px/1.5 Arial,Helvetica,sans-serif;color:#f5f5f5;padding-top:20px;">CHFR LDN.</div>
          <div style="font:400 12px/1.6 Arial,Helvetica,sans-serif;color:#8d8d8d;padding-top:4px;">Luxury. Driven.</div>
          ${opts.footerNote ? `<div style="font:400 11px/1.7 Arial,Helvetica,sans-serif;color:#6f6f6f;padding-top:16px;">${esc(opts.footerNote)}</div>` : ''}
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
