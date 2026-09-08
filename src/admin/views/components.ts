import { esc } from '../../utils/html.js';
import type { RefOption } from '../../domain/refOptions.js';
import { labelFromMap } from '../../domain/refOptions.js';

/** Status chip, coloured from the `tone` stored on the reference option. */
export function statusBadge(refs: Map<string, RefOption[]>, status: string): string {
  const option = (refs.get('status') ?? []).find((o) => o.code === status);
  const tone = String(option?.meta?.tone ?? '');
  return `<span class="badge ${esc(tone)}">${esc(option?.label ?? status)}</span>`;
}

export function priorityBadge(refs: Map<string, RefOption[]>, priority: string): string {
  const label = labelFromMap(refs, 'priority', priority);
  const cls = priority === 'URGENT' ? 'bad' : priority === 'HIGH' ? 'waiting' : '';
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

export function selectField(opts: {
  name: string;
  label: string;
  options: Array<{ value: string; label: string }>;
  value?: string | null;
  includeBlank?: string;
  className?: string;
  id?: string;
}): string {
  const blank = opts.includeBlank !== undefined
    ? `<option value="">${esc(opts.includeBlank)}</option>`
    : '';
  const body = opts.options
    .map(
      (o) =>
        `<option value="${esc(o.value)}"${String(opts.value ?? '') === o.value ? ' selected' : ''}>${esc(o.label)}</option>`,
    )
    .join('');
  return `<label${opts.className ? ` class="${esc(opts.className)}"` : ''}>${esc(opts.label)}
    <select name="${esc(opts.name)}"${opts.id ? ` id="${esc(opts.id)}"` : ''}>${blank}${body}</select>
  </label>`;
}

export function refSelect(
  refs: Map<string, RefOption[]>,
  category: string,
  opts: { name: string; label: string; value?: string | null; includeBlank?: string; className?: string },
): string {
  const options = (refs.get(category) ?? [])
    .filter((o) => o.active || o.code === opts.value)
    .map((o) => ({ value: o.code, label: o.label }));
  return selectField({ ...opts, options });
}

export function textField(opts: {
  name: string;
  label: string;
  value?: string | number | null;
  type?: string;
  className?: string;
  placeholder?: string;
  required?: boolean;
  step?: string;
  min?: string;
  max?: string;
}): string {
  const attrs = [
    `type="${esc(opts.type ?? 'text')}"`,
    `name="${esc(opts.name)}"`,
    `value="${esc(opts.value ?? '')}"`,
    opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : '',
    opts.required ? 'required' : '',
    opts.step ? `step="${esc(opts.step)}"` : '',
    opts.min ? `min="${esc(opts.min)}"` : '',
    opts.max ? `max="${esc(opts.max)}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `<label${opts.className ? ` class="${esc(opts.className)}"` : ''}>${esc(opts.label)}<input ${attrs}></label>`;
}

export function textArea(opts: { name: string; label: string; value?: string | null; rows?: number; className?: string }): string {
  return `<label${opts.className ? ` class="${esc(opts.className)}"` : ''}>${esc(opts.label)}
    <textarea name="${esc(opts.name)}" rows="${opts.rows ?? 4}">${esc(opts.value ?? '')}</textarea>
  </label>`;
}

export function csrfInput(token: string): string {
  return `<input type="hidden" name="_csrf" value="${esc(token)}">`;
}

export function notices(flash: { ok?: string; err?: string; warn?: string }): string {
  return [
    flash.ok ? `<div class="notice ok">${esc(flash.ok)}</div>` : '',
    flash.err ? `<div class="notice err">${esc(flash.err)}</div>` : '',
    flash.warn ? `<div class="notice warn">${esc(flash.warn)}</div>` : '',
  ].join('');
}

export function money(amount: number | null | undefined, currency: string): string {
  if (amount === null || amount === undefined) return '—';
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${Number(amount).toFixed(2)}`;
  }
}

export function definitionList(rows: Array<[string, string]>): string {
  const body = rows
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`)
    .join('');
  return `<dl class="kv">${body}</dl>`;
}
