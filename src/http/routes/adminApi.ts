import { Router, type Request } from 'express';
import { config } from '../../config/env.js';
import { loadRefOptions } from '../../domain/refOptions.js';
import * as bookingsRepo from '../../repositories/bookings.js';
import * as notificationsRepo from '../../repositories/notifications.js';
import { listUsers } from '../../repositories/users.js';
import {
  updateBooking, addNote, markContacted, archiveBooking, restoreBooking, purgeBooking,
} from '../../services/bookings.js';
import {
  retryInternalEmail, retryCustomerAck, retryWhatsApp, syncSpreadsheet,
  sendCustomerWhatsApp, sendStaffEmail,
} from '../../services/notifications.js';
import { bookingsToCsv, bookingsToXlsx, exportFilename } from '../../services/export.js';
import { healthReport } from '../../services/health.js';
import { validateBookingUpdate, noteSchema, manualWhatsAppSchema, manualEmailSchema } from '../../validation/admin.js';
import { requireAuth, requireRole, requireCsrf, actorFrom, noStore } from '../../auth/middleware.js';
import { NotFoundError, ValidationError, AppError } from '../../utils/errors.js';
import { buildFilters, resolveExportScope } from './filters.js';

export const adminApiRouter = Router();

adminApiRouter.use(noStore, requireAuth, requireCsrf);

/** Loads the booking named in :id, 404ing consistently for every route below. */
async function loadBooking(req: Request) {
  const booking = await bookingsRepo.findById(String(req.params.id));
  if (!booking) throw new NotFoundError('Booking not found.');
  return booking;
}

// --------------------------------------------------------------- bookings

adminApiRouter.get('/bookings', async (req, res, next) => {
  try {
    const filters = buildFilters(req.query as Record<string, string>);
    const { rows, total } = await bookingsRepo.listBookings(filters);
    res.json({ ok: true, data: { bookings: rows, total, limit: filters.limit, offset: filters.offset } });
  } catch (err) {
    next(err);
  }
});

adminApiRouter.get('/bookings/:id', async (req, res, next) => {
  try {
    const booking = await loadBooking(req);
    const [events, notifications, whatsapp] = await Promise.all([
      bookingsRepo.listEvents(booking.id),
      notificationsRepo.listNotifications(booking.id),
      notificationsRepo.listWhatsAppMessages(booking.id),
    ]);
    res.json({ ok: true, data: { booking, events, notifications, whatsapp } });
  } catch (err) {
    next(err);
  }
});

adminApiRouter.get('/bookings/:id/history', async (req, res, next) => {
  try {
    const booking = await loadBooking(req);
    res.json({ ok: true, data: { events: await bookingsRepo.listEvents(booking.id) } });
  } catch (err) {
    next(err);
  }
});

adminApiRouter.patch('/bookings/:id', async (req, res, next) => {
  try {
    const booking = await loadBooking(req);
    const { _csrf, ...body } = (req.body ?? {}) as Record<string, unknown>;
    void _csrf;

    const validated = await validateBookingUpdate(body);
    if (!validated.ok) throw new ValidationError(validated.issues);

    const result = await updateBooking(booking.id, validated.patch!, actorFrom(req), {
      notifyCustomer: validated.notifyCustomer,
    });
    if (!result) throw new NotFoundError('Booking not found.');

    res.json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

/** Soft delete. Archiving keeps the record and its audit trail. */
adminApiRouter.delete('/bookings/:id', async (req, res, next) => {
  try {
    const booking = await loadBooking(req);
    const permanent = req.query.permanent === 'true';

    if (permanent) {
      if (req.session!.user.role !== 'ADMIN') {
        throw new AppError('Only an administrator can permanently delete a booking.', 403, 'FORBIDDEN');
      }
      await purgeBooking(booking.id, actorFrom(req));
      res.json({ ok: true, data: { deleted: true, permanent: true } });
      return;
    }

    await archiveBooking(booking.id, actorFrom(req));
    res.json({ ok: true, data: { archived: true } });
  } catch (err) {
    next(err);
  }
});

adminApiRouter.post('/bookings/:id/restore', async (req, res, next) => {
  try {
    const booking = await loadBooking(req);
    await restoreBooking(booking.id, actorFrom(req));
    res.json({ ok: true, data: { restored: true } });
  } catch (err) {
    next(err);
  }
});

adminApiRouter.post('/bookings/:id/notes', async (req, res, next) => {
  try {
    const booking = await loadBooking(req);
    const parsed = noteSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new ValidationError(parsed.error.issues);

    await addNote(booking.id, parsed.data.note, actorFrom(req));
    res.json({ ok: true, data: { added: true } });
  } catch (err) {
    next(err);
  }
});

adminApiRouter.post('/bookings/:id/contacted', async (req, res, next) => {
  try {
    const booking = await loadBooking(req);
    const updated = await markContacted(booking.id, actorFrom(req));
    res.json({ ok: true, data: { booking: updated } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------- notifications

adminApiRouter.post('/bookings/:id/email', async (req, res, next) => {
  try {
    const booking = await loadBooking(req);
    const parsed = manualEmailSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new ValidationError(parsed.error.issues);

    const outcome = await sendStaffEmail(
      booking,
      parsed.data.subject,
      parsed.data.message,
      req.session!.user.id,
    );
    res.json({ ok: outcome.status === 'SENT', data: outcome });
  } catch (err) {
    next(err);
  }
});

adminApiRouter.post('/bookings/:id/whatsapp', async (req, res, next) => {
  try {
    const booking = await loadBooking(req);
    const parsed = manualWhatsAppSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new ValidationError(parsed.error.issues);

    // An outbound message to a customer is never sent without an explicit
    // confirmation flag from the caller.
    const confirmed = parsed.data.confirm === true || ['true', 'yes', 'on', '1'].includes(String(parsed.data.confirm));
    if (!confirmed) throw new AppError('Confirmation is required before sending a WhatsApp message.', 400, 'CONFIRM_REQUIRED');

    const outcome = await sendCustomerWhatsApp(booking, parsed.data.message, req.session!.user.id);
    res.json({ ok: outcome.status === 'SENT', data: outcome });
  } catch (err) {
    next(err);
  }
});

const RETRIES: Record<string, (booking: any) => Promise<any>> = {
  'internal-email': retryInternalEmail,
  'customer-email': retryCustomerAck,
  whatsapp: retryWhatsApp,
  spreadsheet: syncSpreadsheet,
};

adminApiRouter.post('/bookings/:id/retry/:channel', async (req, res, next) => {
  try {
    const booking = await loadBooking(req);
    const retry = RETRIES[String(req.params.channel)];
    if (!retry) throw new NotFoundError('Unknown notification channel.');

    const outcome = await retry(booking);
    res.json({ ok: outcome.status === 'SENT', data: outcome });
  } catch (err) {
    next(err);
  }
});

/** Kept as an explicit alias — the brief names this endpoint directly. */
adminApiRouter.post('/bookings/:id/whatsapp/retry', async (req, res, next) => {
  try {
    const booking = await loadBooking(req);
    const outcome = await retryWhatsApp(booking);
    res.json({ ok: outcome.status === 'SENT', data: outcome });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------------- export

adminApiRouter.get('/export/bookings', async (req, res, next) => {
  try {
    const query = req.query as Record<string, string>;
    const { filters, scope } = resolveExportScope(query);
    const [rows, refs] = await Promise.all([bookingsRepo.listAllBookings(filters), loadRefOptions()]);

    const format = query.format === 'xlsx' ? 'xlsx' : 'csv';
    const filename = exportFilename(scope, format);

    if (format === 'xlsx') {
      const buffer = await bookingsToXlsx(rows, refs);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(buffer);
      return;
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(bookingsToCsv(rows, refs));
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------- reference

adminApiRouter.get('/reference', async (_req, res, next) => {
  try {
    const refs = await loadRefOptions();
    res.json({ ok: true, data: Object.fromEntries(refs) });
  } catch (err) {
    next(err);
  }
});

adminApiRouter.get('/staff', async (_req, res, next) => {
  try {
    res.json({ ok: true, data: { staff: await listUsers() } });
  } catch (err) {
    next(err);
  }
});

adminApiRouter.get('/notifications/failed', async (_req, res, next) => {
  try {
    res.json({ ok: true, data: { failures: await notificationsRepo.listFailedNotifications() } });
  } catch (err) {
    next(err);
  }
});

adminApiRouter.get('/health', async (_req, res, next) => {
  try {
    res.json({ ok: true, data: await healthReport({ deep: true }) });
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------- whatsapp

adminApiRouter.get('/whatsapp/status', async (_req, res, next) => {
  try {
    const { whatsAppProvider } = await import('../../services/whatsapp/index.js');
    const provider = whatsAppProvider();
    res.json({
      ok: true,
      data: {
        configured: provider.configured,
        provider: provider.name,
        businessNumber: config.CHFR_WHATSAPP_NUMBER ?? null,
        status: await provider.status(),
      },
    });
  } catch (err) {
    next(err);
  }
});

adminApiRouter.post('/whatsapp/:action(connect|disconnect|qr)', requireRole('ADMIN', 'STAFF'), async (req, res, next) => {
  try {
    const { whatsAppProvider } = await import('../../services/whatsapp/index.js');
    const provider = whatsAppProvider();
    const action = String(req.params.action);

    if (action === 'disconnect' && req.session!.user.role !== 'ADMIN') {
      throw new AppError('Only an administrator can disconnect the WhatsApp session.', 403, 'FORBIDDEN');
    }

    if (action === 'connect') {
      res.json({ ok: true, data: (await provider.start?.()) ?? { ok: false, error: 'Not supported by this provider' } });
      return;
    }
    if (action === 'disconnect') {
      res.json({ ok: true, data: (await provider.stop?.()) ?? { ok: false, error: 'Not supported by this provider' } });
      return;
    }
    res.json({ ok: true, data: (await provider.qr?.()) ?? { ok: false, error: 'Not supported by this provider' } });
  } catch (err) {
    next(err);
  }
});
