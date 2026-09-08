import type { BookingListFilters } from '../../repositories/bookings.js';
import { todayIso, addDaysIso, isValidIsoDate } from '../../utils/dates.js';
import { OPEN_STATUSES } from '../../domain/refOptions.js';

const SORTS = new Set(['newest', 'oldest', 'journey_date', 'journey_date_desc', 'updated']);

const date = (value: string | undefined): string | undefined =>
  value && isValidIsoDate(value) ? value : undefined;

/** Turns query-string parameters into repository filters, safely. */
export function buildFilters(query: Record<string, string>): BookingListFilters {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 500);

  return {
    search: query.q?.slice(0, 200) || undefined,
    status: query.status ? [query.status] : undefined,
    journey_type: query.journey_type || undefined,
    preferred_vehicle: query.vehicle || query.preferred_vehicle || undefined,
    priority: query.priority || undefined,
    assigned_to: query.assigned_to || undefined,
    date_from: date(query.date_from),
    date_to: date(query.date_to),
    created_from: date(query.created_from),
    created_to: date(query.created_to),
    includeArchived: query.archived === 'include',
    onlyArchived: query.archived === 'only',
    sort: SORTS.has(query.sort ?? '') ? (query.sort as BookingListFilters['sort']) : 'newest',
    limit,
    offset: (page - 1) * limit,
  };
}

/**
 * Named export scopes ("today", "upcoming", "confirmed"…) on top of the same
 * filter builder, so an export always matches what the dashboard shows.
 */
export function resolveExportScope(query: Record<string, string>): { filters: BookingListFilters; scope: string } {
  const base = buildFilters(query);
  const today = todayIso();
  const scope = query.scope ?? 'all';

  switch (scope) {
    case 'today':
      return { filters: { ...base, date_from: today, date_to: today, sort: 'journey_date' }, scope: 'today' };
    case 'upcoming':
      return { filters: { ...base, date_from: today, sort: 'journey_date' }, scope: 'upcoming' };
    case 'next7':
      return { filters: { ...base, date_from: today, date_to: addDaysIso(today, 7), sort: 'journey_date' }, scope: 'next-7-days' };
    case 'confirmed':
      return { filters: { ...base, status: ['CONFIRMED'] }, scope: 'confirmed' };
    case 'completed':
      return { filters: { ...base, status: ['COMPLETED'] }, scope: 'completed' };
    case 'cancelled':
      return { filters: { ...base, status: ['CANCELLED'] }, scope: 'cancelled' };
    case 'open':
      return { filters: { ...base, status: OPEN_STATUSES }, scope: 'open' };
    case 'filtered':
      return { filters: base, scope: 'filtered' };
    default:
      return { filters: base, scope: query.q || query.status ? 'filtered' : 'all' };
  }
}
