const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape untrusted text for interpolation into HTML. Every customer-supplied
 * value in an email template or admin page goes through this.
 */
export function esc(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
}

/** Escape and convert newlines to <br> for multi-line free text. */
export function escMultiline(value: unknown): string {
  return esc(value).replace(/\r?\n/g, '<br>');
}

/** Escape a value for safe use inside a JS string in an inline <script>. */
export function escJson(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}
