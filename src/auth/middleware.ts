import type { Request, Response, NextFunction } from 'express';
import { config } from '../config/env.js';
import { AuthError, ForbiddenError } from '../utils/errors.js';
import { safeEqual } from '../utils/crypto.js';
import { SESSION_COOKIE, findSession, type SessionRecord } from './session.js';

declare module 'express-serve-static-core' {
  interface Request {
    session?: SessionRecord;
    csrfToken?: string;
  }
}

/** Attaches req.session when a valid cookie is present. Never rejects. */
export async function loadSession(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) {
      const session = await findSession(token);
      if (session) {
        req.session = session;
        req.csrfToken = session.csrfToken;
      }
    }
  } catch {
    // A session lookup failure must not take the whole request down; the user
    // is simply treated as logged out.
  }
  next();
}

/** JSON API guard. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.session) return next(new AuthError());
  next();
}

/** HTML guard — redirects to the login page rather than returning 401 JSON. */
export function requireAuthPage(req: Request, res: Response, next: NextFunction): void {
  if (!req.session) {
    const target = encodeURIComponent(req.originalUrl || '/admin');
    return res.redirect(`/admin/login?next=${target}`);
  }
  next();
}

export function requireRole(...roles: Array<'ADMIN' | 'STAFF'>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.session) return next(new AuthError());
    if (!roles.includes(req.session.user.role)) return next(new ForbiddenError());
    next();
  };
}

/**
 * CSRF protection for cookie-authenticated state changes.
 *
 * The token is bound to the session and compared in constant time. Safe methods
 * are exempt; so are requests with no session (there is nothing to ride on).
 */
export function requireCsrf(req: Request, _res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.session) return next(new AuthError());

  const provided =
    (req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>)._csrf : undefined) ??
    req.get('x-csrf-token') ??
    '';

  if (typeof provided !== 'string' || !provided || !safeEqual(provided, req.session.csrfToken)) {
    return next(new ForbiddenError('Your session has expired. Please refresh the page and try again.'));
  }
  next();
}

/** Admin pages must never be cached or indexed. */
export function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  next();
}

export function actorFrom(req: Request): { userId: string | null; label: string; role?: 'ADMIN' | 'STAFF' } {
  if (!req.session) return { userId: null, label: 'System' };
  return { userId: req.session.user.id, label: req.session.user.name, role: req.session.user.role };
}

export function isProductionInsecureRequest(req: Request): boolean {
  return config.isProduction && req.protocol !== 'https' && req.get('x-forwarded-proto') !== 'https';
}
