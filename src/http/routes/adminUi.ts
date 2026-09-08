import { Router, type Request, type Response, type NextFunction } from 'express';
import { config } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { hashIp } from '../../utils/crypto.js';
import { loadRefOptions, OPEN_STATUSES } from '../../domain/refOptions.js';
import { todayIso, addDaysIso, isValidIsoDate } from '../../utils/dates.js';
import * as bookingsRepo from '../../repositories/bookings.js';
import * as notificationsRepo from '../../repositories/notifications.js';
import * as usersRepo from '../../repositories/users.js';
import {
  updateBooking, addNote, markContacted, archiveBooking, restoreBooking, purgeBooking,
} from '../../services/bookings.js';
import {
  retryInternalEmail, retryCustomerAck, retryWhatsApp, syncSpreadsheet, sendCustomerWhatsApp,
} from '../../services/notifications.js';
import { whatsAppProvider } from '../../services/whatsapp/index.js';
import { healthReport } from '../../services/health.js';
import { hashPassword, verifyPassword, passwordIssues, DUMMY_HASH } from '../../auth/password.js';
import {
  createSession, destroySession, destroyUserSessions,
  SESSION_COOKIE, sessionCookieOptions,
} from '../../auth/session.js';
import {
  requireAuthPage, requireRole, requireCsrf, actorFrom, noStore,
} from '../../auth/middleware.js';
import { loginSchema, validateBookingUpdate, noteSchema, createUserSchema } from '../../validation/admin.js';
import { rateLimit, clientIp } from '../middleware/rateLimit.js';
import { adminLayout, loginPage } from '../../admin/views/layout.js';
import { dashboardPage } from '../../admin/views/dashboard.js';
import { bookingListPage } from '../../admin/views/bookingList.js';
import { bookingDetailPage } from '../../admin/views/bookingDetail.js';
import { todayPage, upcomingPage } from '../../admin/views/operations.js';
import { whatsappPage } from '../../admin/views/whatsapp.js';
import { usersPage } from '../../admin/views/users.js';
import { buildFilters } from './filters.js';
import { NotFoundError } from '../../utils/errors.js';

export const adminUiRouter = Router();
adminUiRouter.use(noStore);

/**
 * Flash messages travel in the query string as codes, never as free text, so a
 * crafted link can never inject a message into the page.
 */
const MESSAGES: Record<string, { kind: 'ok' | 'err' | 'warn'; text: string }> = {
  saved: { kind: 'ok', text: 'Booking updated. Every change has been recorded in the history.' },
  nochange: { kind: 'warn', text: 'Nothing to save — no values were different.' },
  noted: { kind: 'ok', text: 'Note added to the booking history.' },
  contacted: { kind: 'ok', text: 'Booking marked as contacted.' },
  archived: { kind: 'ok', text: 'Booking archived. It keeps its full history.' },
  restored: { kind: 'ok', text: 'Booking restored from the archive.' },
  deleted: { kind: 'ok', text: 'Booking permanently deleted.' },
  sent: { kind: 'ok', text: 'Message sent.' },
  resent: { kind: 'ok', text: 'Notification re-sent successfully.' },
  synced: { kind: 'ok', text: 'Spreadsheet row updated.' },
  notified: { kind: 'ok', text: 'Booking updated and the customer has been emailed.' },
  usercreated: { kind: 'ok', text: 'Staff account created.' },
  usertoggled: { kind: 'ok', text: 'Account updated.' },
  passwordchanged: { kind: 'ok', text: 'Password updated. Your other sessions have been signed out.' },
  waconnect: { kind: 'ok', text: 'Connect requested. Refresh the QR code to pair the device.' },
  wadisconnect: { kind: 'ok', text: 'WhatsApp session disconnected.' },
  failed: { kind: 'err', text: 'That did not work. Check the details below and try again.' },
  sendfailed: { kind: 'err', text: 'The message could not be sent. The failure has been logged — see the booking history.' },
  invalid: { kind: 'err', text: 'Some values were not accepted. Please check the form and try again.' },
  forbidden: { kind: 'err', text: 'You do not have permission to do that.' },
  weakpassword: { kind: 'err', text: 'That password is too weak. Use at least 12 characters with upper case, lower case and a number.' },
  wrongpassword: { kind: 'err', text: 'Your current password was not correct.' },
  duplicateuser: { kind: 'err', text: 'An account with that email already exists.' },
};

function flashFrom(req: Request): { ok?: string; err?: string; warn?: string } {
  const code = String(req.query.msg ?? '');
  const entry = MESSAGES[code];
  if (!entry) return {};
  return { [entry.kind]: entry.text };
}

const redirectWith = (res: Response, path: string, msg: string) =>
  res.redirect(`${path}${path.includes('?') ? '&' : '?'}msg=${msg}`);

// ------------------------------------------------------------------ login

adminUiRouter.get('/login', (req: Request, res: Response) => {
  if (req.session) return res.redirect('/admin');
  const next = typeof req.query.next === 'string' && req.query.next.startsWith('/admin') ? req.query.next : '/admin';
  res.type('html').send(loginPage({ next, error: req.query.error === '1' ? 'Email or password not recognised.' : undefined }));
});

adminUiRouter.post(
  '/login',
  rateLimit({
    name: 'login',
    max: config.LOGIN_RATE_LIMIT_MAX,
    windowMinutes: config.LOGIN_RATE_LIMIT_WINDOW_MIN,
    message: 'Too many sign-in attempts. Please wait and try again.',
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = loginSchema.safeParse(req.body ?? {});
      const target =
        typeof req.body?.next === 'string' && req.body.next.startsWith('/admin') ? req.body.next : '/admin';

      if (!parsed.success) return res.redirect(`/admin/login?error=1&next=${encodeURIComponent(target)}`);

      const user = await usersRepo.findUserByEmail(parsed.data.email);
      // Always run a bcrypt comparison, even for an unknown email, so response
      // time does not reveal whether the account exists.
      const valid = await verifyPassword(parsed.data.password, user?.password_hash ?? DUMMY_HASH);

      if (!user || !user.active || !valid) {
        logger.warn({ email: parsed.data.email, ip: hashIp(clientIp(req)) }, 'Failed sign-in attempt');
        return res.redirect(`/admin/login?error=1&next=${encodeURIComponent(target)}`);
      }

      const session = await createSession(user, {
        userAgent: req.get('user-agent') ?? null,
        ipHash: hashIp(clientIp(req)),
      });
      await usersRepo.touchLogin(user.id);
      res.setCookie(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));

      logger.info({ userId: user.id }, 'Staff signed in');
      res.redirect(target);
    } catch (err) {
      next(err);
    }
  },
);

adminUiRouter.post('/logout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await destroySession(token);
    res.clearCookie2(SESSION_COOKIE, { path: '/' });
    res.redirect('/admin/login');
  } catch (err) {
    next(err);
  }
});

// Everything past this point requires a signed-in staff member.
adminUiRouter.use(requireAuthPage);

const render = (req: Request, res: Response, title: string, active: string, body: string) =>
  res.type('html').send(adminLayout({ title, active, user: req.session!.user, body }));

// -------------------------------------------------------------- dashboard

adminUiRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const today = todayIso();
    const [metrics, refs, todayRows, upcoming, newLeads, failures, health] = await Promise.all([
      bookingsRepo.dashboardMetrics(today),
      loadRefOptions(),
      bookingsRepo.listAllBookings({ date_from: today, date_to: today, sort: 'journey_date', limit: 20 }),
      bookingsRepo.listBookings({ date_from: addDaysIso(today, 1), sort: 'journey_date', limit: 8 }),
      bookingsRepo.listBookings({ status: ['NEW_LEAD'], sort: 'newest', limit: 8 }),
      notificationsRepo.listFailedNotifications(20),
      healthReport({ deep: false }),
    ]);

    render(req, res, 'Overview', 'overview',
      dashboardPage({
        metrics, refs,
        today: todayRows,
        upcoming: upcoming.rows,
        newLeads: newLeads.rows,
        failures, health,
        flash: flashFrom(req),
      }),
    );
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------- bookings

adminUiRouter.get('/bookings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = req.query as Record<string, string>;
    const filters = buildFilters(query);
    const [{ rows, total }, refs, staff] = await Promise.all([
      bookingsRepo.listBookings(filters),
      loadRefOptions(),
      usersRepo.listUsers(),
    ]);

    render(req, res, 'Bookings', 'bookings',
      bookingListPage({
        rows, total, refs, staff, query,
        page: Math.max(1, Number(query.page) || 1),
        pageSize: filters.limit ?? 50,
        flash: flashFrom(req),
      }),
    );
  } catch (err) {
    next(err);
  }
});

adminUiRouter.get('/bookings/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const booking = await bookingsRepo.findById(String(req.params.id));
    if (!booking) throw new NotFoundError('That booking does not exist.');

    const [events, notifications, whatsappMessages, refs, staff] = await Promise.all([
      bookingsRepo.listEvents(booking.id),
      notificationsRepo.listNotifications(booking.id),
      notificationsRepo.listWhatsAppMessages(booking.id),
      loadRefOptions(),
      usersRepo.listUsers(),
    ]);

    render(req, res, booking.booking_reference, 'bookings',
      bookingDetailPage({
        booking, events, notifications, whatsappMessages, refs, staff,
        user: req.session!.user,
        csrf: req.session!.csrfToken,
        whatsappConfigured: whatsAppProvider().configured,
        flash: flashFrom(req),
      }),
    );
  } catch (err) {
    next(err);
  }
});

// All state-changing form posts below are CSRF-protected.
adminUiRouter.use(requireCsrf);

adminUiRouter.post('/bookings/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { _csrf, ...body } = (req.body ?? {}) as Record<string, unknown>;
    void _csrf;

    const validated = await validateBookingUpdate(body);
    if (!validated.ok) {
      logger.warn({ id, issues: validated.issues }, 'Rejected booking update');
      return redirectWith(res, `/admin/bookings/${id}`, 'invalid');
    }

    const result = await updateBooking(id, validated.patch!, actorFrom(req), {
      notifyCustomer: validated.notifyCustomer,
    });
    if (!result) throw new NotFoundError('That booking does not exist.');

    if (result.changes.length === 0) return redirectWith(res, `/admin/bookings/${id}`, 'nochange');
    return redirectWith(res, `/admin/bookings/${id}`, result.customerNotification?.sent ? 'notified' : 'saved');
  } catch (err) {
    next(err);
  }
});

adminUiRouter.post('/bookings/:id/notes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const parsed = noteSchema.safeParse(req.body ?? {});
    if (!parsed.success) return redirectWith(res, `/admin/bookings/${id}`, 'invalid');

    const added = await addNote(id, parsed.data.note, actorFrom(req));
    if (!added) throw new NotFoundError('That booking does not exist.');
    redirectWith(res, `/admin/bookings/${id}`, 'noted');
  } catch (err) {
    next(err);
  }
});

adminUiRouter.post('/bookings/:id/contacted', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const updated = await markContacted(id, actorFrom(req));
    if (!updated) throw new NotFoundError('That booking does not exist.');
    redirectWith(res, `/admin/bookings/${id}`, 'contacted');
  } catch (err) {
    next(err);
  }
});

adminUiRouter.post('/bookings/:id/archive', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    if (!(await archiveBooking(id, actorFrom(req)))) throw new NotFoundError('That booking does not exist.');
    redirectWith(res, `/admin/bookings/${id}`, 'archived');
  } catch (err) {
    next(err);
  }
});

adminUiRouter.post('/bookings/:id/restore', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    if (!(await restoreBooking(id, actorFrom(req)))) throw new NotFoundError('That booking does not exist.');
    redirectWith(res, `/admin/bookings/${id}`, 'restored');
  } catch (err) {
    next(err);
  }
});

adminUiRouter.post('/bookings/:id/delete', requireRole('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!(await purgeBooking(String(req.params.id), actorFrom(req)))) {
      throw new NotFoundError('That booking does not exist.');
    }
    redirectWith(res, '/admin/bookings', 'deleted');
  } catch (err) {
    next(err);
  }
});

adminUiRouter.post('/bookings/:id/whatsapp', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const booking = await bookingsRepo.findById(id);
    if (!booking) throw new NotFoundError('That booking does not exist.');

    const message = String(req.body?.message ?? '').trim();
    const confirmed = ['yes', 'true', 'on', '1'].includes(String(req.body?.confirm ?? '').toLowerCase());
    if (!message || !confirmed) return redirectWith(res, `/admin/bookings/${id}`, 'invalid');

    const outcome = await sendCustomerWhatsApp(booking, message.slice(0, 4000), req.session!.user.id);
    redirectWith(res, `/admin/bookings/${id}`, outcome.status === 'SENT' ? 'sent' : 'sendfailed');
  } catch (err) {
    next(err);
  }
});

const RETRY_ACTIONS: Record<string, (b: any) => Promise<{ status: string }>> = {
  'internal-email': retryInternalEmail,
  'customer-email': retryCustomerAck,
  whatsapp: retryWhatsApp,
  spreadsheet: syncSpreadsheet,
};

adminUiRouter.post('/bookings/:id/retry/:channel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const booking = await bookingsRepo.findById(id);
    if (!booking) throw new NotFoundError('That booking does not exist.');

    const retry = RETRY_ACTIONS[String(req.params.channel)];
    if (!retry) throw new NotFoundError('Unknown notification channel.');

    const outcome = await retry(booking);
    const success = outcome.status === 'SENT';
    redirectWith(
      res,
      `/admin/bookings/${id}`,
      success ? (req.params.channel === 'spreadsheet' ? 'synced' : 'resent') : 'sendfailed',
    );
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------- operations

adminUiRouter.get('/today', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const date = typeof req.query.date === 'string' && isValidIsoDate(req.query.date) ? req.query.date : todayIso();
    const [rows, refs] = await Promise.all([
      bookingsRepo.listAllBookings({ date_from: date, date_to: date, sort: 'journey_date' }),
      loadRefOptions(),
    ]);
    render(req, res, 'Today', 'today', todayPage({ rows, date, refs, flash: flashFrom(req) }));
  } catch (err) {
    next(err);
  }
});

adminUiRouter.get('/upcoming', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const today = todayIso();
    const range = String(req.query.range ?? '7');

    let from = today;
    let to = addDaysIso(today, 7);
    if (range === 'today') { to = today; }
    else if (range === 'tomorrow') { from = addDaysIso(today, 1); to = from; }
    else if (range === '30') { to = addDaysIso(today, 30); }
    else if (range === 'custom') {
      const qf = typeof req.query.from === 'string' && isValidIsoDate(req.query.from) ? req.query.from : today;
      const qt = typeof req.query.to === 'string' && isValidIsoDate(req.query.to) ? req.query.to : addDaysIso(today, 30);
      from = qf;
      to = qt < qf ? qf : qt;
    }

    const [rows, refs] = await Promise.all([
      bookingsRepo.listAllBookings({
        date_from: from,
        date_to: to,
        status: OPEN_STATUSES,
        sort: 'journey_date',
      }),
      loadRefOptions(),
    ]);

    render(req, res, 'Upcoming', 'upcoming', upcomingPage({ rows, refs, range, from, to, flash: flashFrom(req) }));
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------- whatsapp

adminUiRouter.get('/whatsapp', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const provider = whatsAppProvider();
    const status = await provider.status();
    render(req, res, 'WhatsApp', 'whatsapp',
      whatsappPage({
        status,
        configured: provider.configured,
        businessNumber: config.CHFR_WHATSAPP_NUMBER,
        csrf: req.session!.csrfToken,
        isAdmin: req.session!.user.role === 'ADMIN',
        flash: flashFrom(req),
      }),
    );
  } catch (err) {
    next(err);
  }
});

adminUiRouter.post('/whatsapp/connect', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await whatsAppProvider().start?.();
    redirectWith(res, '/admin/whatsapp', result?.ok ? 'waconnect' : 'failed');
  } catch (err) {
    next(err);
  }
});

adminUiRouter.post('/whatsapp/disconnect', requireRole('ADMIN'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await whatsAppProvider().stop?.();
    redirectWith(res, '/admin/whatsapp', result?.ok ? 'wadisconnect' : 'failed');
  } catch (err) {
    next(err);
  }
});

adminUiRouter.post('/whatsapp/qr', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const provider = whatsAppProvider();
    const [status, qr] = await Promise.all([provider.status(), provider.qr?.() ?? Promise.resolve(undefined)]);

    render(req, res, 'WhatsApp', 'whatsapp',
      whatsappPage({
        status,
        configured: provider.configured,
        qr: qr?.ok ? qr.qr : null,
        businessNumber: config.CHFR_WHATSAPP_NUMBER,
        csrf: req.session!.csrfToken,
        isAdmin: req.session!.user.role === 'ADMIN',
        flash: qr && !qr.ok ? { err: `Could not fetch a QR code: ${qr.error ?? 'unknown error'}` } : {},
      }),
    );
  } catch (err) {
    next(err);
  }
});

adminUiRouter.post('/whatsapp/test', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const provider = whatsAppProvider();
    const { normalisePhone } = await import('../../utils/phone.js');
    const to = normalisePhone(config.CHFR_WHATSAPP_NUMBER ?? '');
    if (!to) return redirectWith(res, '/admin/whatsapp', 'failed');

    const body = String(req.body?.message ?? 'CHFR system test').slice(0, 1000);
    const result = await provider.sendText(to, body);

    await notificationsRepo.logWhatsApp({
      bookingId: null,
      recipient: to,
      body,
      status: result.ok ? 'SENT' : 'FAILED',
      provider: provider.name,
      providerMessageId: result.messageId ?? null,
      errorMessage: result.error ?? null,
      sentBy: req.session!.user.id,
    });

    redirectWith(res, '/admin/whatsapp', result.ok ? 'sent' : 'sendfailed');
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ users

adminUiRouter.get('/users', requireRole('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    render(req, res, 'Staff accounts', 'users',
      usersPage({
        users: await usersRepo.listUsers(),
        currentUser: req.session!.user,
        csrf: req.session!.csrfToken,
        flash: flashFrom(req),
      }),
    );
  } catch (err) {
    next(err);
  }
});

adminUiRouter.post('/users', requireRole('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = createUserSchema.safeParse(req.body ?? {});
    if (!parsed.success) return redirectWith(res, '/admin/users', 'invalid');

    const issues = passwordIssues(parsed.data.password);
    if (issues.length) return redirectWith(res, '/admin/users', 'weakpassword');

    if (await usersRepo.findUserByEmail(parsed.data.email)) {
      return redirectWith(res, '/admin/users', 'duplicateuser');
    }

    await usersRepo.createUser({
      email: parsed.data.email,
      name: parsed.data.name,
      role: parsed.data.role,
      password_hash: await hashPassword(parsed.data.password),
    });
    logger.info({ by: req.session!.user.id, role: parsed.data.role }, 'Staff account created');
    redirectWith(res, '/admin/users', 'usercreated');
  } catch (err) {
    next(err);
  }
});

adminUiRouter.post('/users/password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const current = String(req.body?.current_password ?? '');
    const next_ = String(req.body?.new_password ?? '');

    const me = await usersRepo.findUserByEmail(req.session!.user.email);
    if (!me || !(await verifyPassword(current, me.password_hash))) {
      return redirectWith(res, '/admin/users', 'wrongpassword');
    }
    if (passwordIssues(next_).length) return redirectWith(res, '/admin/users', 'weakpassword');

    await usersRepo.updateUserPassword(me.id, await hashPassword(next_));
    // Every other session is invalidated, then a fresh one is issued here.
    await destroyUserSessions(me.id);

    const session = await createSession(req.session!.user, {
      userAgent: req.get('user-agent') ?? null,
      ipHash: hashIp(clientIp(req)),
    });
    res.setCookie(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));

    logger.info({ userId: me.id }, 'Password changed');
    redirectWith(res, '/admin/users', 'passwordchanged');
  } catch (err) {
    next(err);
  }
});

adminUiRouter.post('/users/:id/toggle', requireRole('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    if (id === req.session!.user.id) return redirectWith(res, '/admin/users', 'forbidden');

    const target = await usersRepo.findUserById(id);
    if (!target) throw new NotFoundError('That account does not exist.');

    await usersRepo.setUserActive(id, !target.active);
    // Disabling an account cuts its live sessions immediately.
    if (target.active) await destroyUserSessions(id);

    redirectWith(res, '/admin/users', 'usertoggled');
  } catch (err) {
    next(err);
  }
});
