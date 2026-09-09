import { db } from '../db/index.js';

/**
 * Reference options (statuses, vehicles, journey types…) are loaded from the
 * database and cached briefly. Adding a new status is an INSERT — no code
 * change, no deploy, and the admin UI picks it up automatically.
 */

export interface RefOption {
  category: string;
  code: string;
  label: string;
  sort_order: number;
  active: boolean;
  meta: Record<string, unknown>;
}

export type RefCategory = 'status' | 'priority' | 'payment_status' | 'journey_type' | 'vehicle' | 'luggage';

const CACHE_TTL_MS = 30_000;
let cache: { at: number; byCategory: Map<string, RefOption[]> } | undefined;

export async function loadRefOptions(force = false): Promise<Map<string, RefOption[]>> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.byCategory;

  const { rows } = await db().query<RefOption>(
    `SELECT category, code, label, sort_order, active, meta
       FROM ref_options
      ORDER BY category, sort_order, code`,
  );

  const byCategory = new Map<string, RefOption[]>();
  for (const row of rows) {
    const meta = typeof row.meta === 'string' ? JSON.parse(row.meta) : (row.meta ?? {});
    const list = byCategory.get(row.category) ?? [];
    list.push({ ...row, meta });
    byCategory.set(row.category, list);
  }
  cache = { at: Date.now(), byCategory };
  return byCategory;
}

export function clearRefOptionCache(): void {
  cache = undefined;
}

export async function optionsFor(category: RefCategory, includeInactive = false): Promise<RefOption[]> {
  const all = (await loadRefOptions()).get(category) ?? [];
  return includeInactive ? all : all.filter((o) => o.active);
}

export async function codesFor(category: RefCategory): Promise<string[]> {
  return (await optionsFor(category)).map((o) => o.code);
}

export async function isValidCode(category: RefCategory, code: string): Promise<boolean> {
  return (await codesFor(category)).includes(code);
}

/** Human label for a stored code; falls back to the code so unknown values still render. */
export async function labelFor(category: RefCategory, code: string | null | undefined): Promise<string> {
  if (!code) return 'Not set';
  const all = (await loadRefOptions()).get(category) ?? [];
  return all.find((o) => o.code === code)?.label ?? code;
}

/** A label lookup usable synchronously by templates that already loaded the map. */
export function labelFromMap(map: Map<string, RefOption[]>, category: RefCategory, code: string | null | undefined): string {
  if (!code) return 'Not set';
  return (map.get(category) ?? []).find((o) => o.code === code)?.label ?? code;
}

/** Statuses treated as "the journey is still live", used by the operations views. */
export const OPEN_STATUSES = ['NEW_LEAD', 'CONTACTED', 'QUOTED', 'AWAITING_CUSTOMER', 'CONFIRMED', 'GOING'];
export const DEFAULT_STATUS = 'NEW_LEAD';
