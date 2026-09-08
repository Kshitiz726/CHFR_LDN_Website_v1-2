import { Router, type Request, type Response, type NextFunction } from 'express';
import { config } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { hashIp } from '../../utils/crypto.js';
import { validatePublicBooking } from '../../validation/booking.js';
import { createBooking } from '../../services/bookings.js';
import { optionsFor } from '../../domain/refOptions.js';
import { healthReport } from '../../services/health.js';
import { rateLimit, clientIp } from '../middleware/rateLimit.js';
import { verifyTurnstile, turnstileEnabled } from '../middleware/turnstile.js';
import { AppError } from '../../utils/errors.js';

export const publicRouter = Router();

/**
 * Form options, so the booking form's selects come from the same reference
 * table the server validates against and can never drift out of sync.
 */
publicRouter.get('/booking-options', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [vehicles, journeyTypes, luggage] = await Promise.all([
      optionsFor('vehicle'),
      optionsFor('journey_type'),
      optionsFor('luggage'),
    ]);
    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      ok: true,
      data: {
        vehicles: vehicles.map((o) => ({ value: o.code, label: o.label })),
        journeyTypes: journeyTypes.map((o) => ({ value: o.code, label: o.label })),
        luggage: luggage.map((o) => ({ value: o.code, label: o.label })),
        turnstileSiteKey: turnstileEnabled() ? config.TURNSTILE_SITE_KEY : null,
      },
    });
  } catch (err) {
    next(err);
  }
});

publicRouter.post(
  '/bookings',
  rateLimit({
    name: 'booking',
    max: config.BOOKING_RATE_LIMIT_MAX,
    windowMinutes: config.BOOKING_RATE_LIMIT_WINDOW_MIN,
    message: 'We have received several requests from you already. Please contact CHFR directly if this is urgent.',
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = (req.body ?? {}) as Record<string, unknown>;

      // Honeypot: a real browser leaves this hidden field empty. Respond as if
      // everything worked so a bot learns nothing, but create nothing.
      if (typeof payload.company_website === 'string' && payload.company_website.trim() !== '') {
        logger.warn({ ip: hashIp(clientIp(req)) }, 'Honeypot triggered — submission discarded');
        res.status(202).json({
          ok: true,
          data: {
            booking_reference: 'CHFR-PENDING',
            message: 'Your booking request has been received. A CHFR concierge will confirm availability and pricing.',
          },
        });
        return;
      }

      const turnstile = await verifyTurnstile(
        typeof payload.turnstile_token === 'string' ? payload.turnstile_token : undefined,
        clientIp(req),
      );
      if (!turnstile.ok) {
        throw new AppError(
          'We could not verify that you are human. Please refresh the page and try again.',
          400,
          'BOT_CHECK_FAILED',
        );
      }

      const validation = await validatePublicBooking(payload);
      if (!validation.ok || !validation.value) {
        res.status(400).json({
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Some of the details need checking.',
            fields: validation.issues,
          },
        });
        return;
      }

      const idempotencyKey =
        (typeof payload.idempotency_key === 'string' ? payload.idempotency_key : undefined) ??
        req.get('idempotency-key') ??
        undefined;

      const result = await createBooking(validation.value, {
        idempotencyKey,
        source: 'WEBSITE',
        userAgent: req.get('user-agent') ?? null,
        ipHash: hashIp(clientIp(req)),
      });

      // The booking is committed at this point. Notification failures are
      // recorded and retried from the dashboard — they never fail the request.
      if (config.isTest) {
        await result.dispatch;
      } else {
        result.dispatch.catch((err) => logger.error({ err }, 'Notification dispatch failed'));
      }

      res.status(result.duplicate ? 200 : 201).json({
        ok: true,
        data: {
          booking_reference: result.booking.booking_reference,
          duplicate: result.duplicate,
          message:
            'Your booking request has been received. A CHFR concierge will review your request and confirm availability and pricing directly with you.',
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Health endpoint. Shallow by default so an uptime monitor is cheap;
 * `?deep=1` performs the SMTP and spreadsheet round-trips.
 */
publicRouter.get('/health', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const report = await healthReport({
      deep: req.query.deep === '1' || req.query.deep === 'true',
      // Failure details are only shown to signed-in staff; the public endpoint
      // stays a plain up/down signal.
      includeDiagnostics: Boolean(req.session),
    });
    res.status(report.ok ? 200 : 503).json(report);
  } catch (err) {
    next(err);
  }
});
