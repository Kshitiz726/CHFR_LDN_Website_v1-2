import type { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { config } from '../../config/env.js';

/**
 * Security headers. The CSP is written for the actual page: Google Fonts for
 * the marketing site, a Turnstile widget when configured, and nothing else.
 */
export function securityHeaders() {
  const scriptSrc = ["'self'"];
  const frameSrc = ["'none'"];
  const connectSrc = ["'self'"];

  if (config.TURNSTILE_SITE_KEY) {
    scriptSrc.push('https://challenges.cloudflare.com');
    frameSrc.length = 0;
    frameSrc.push('https://challenges.cloudflare.com');
    connectSrc.push('https://challenges.cloudflare.com');
  }

  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        scriptSrc,
        // The admin pages use a small amount of inline styling for status
        // colours. Two font hosts, and both are load-bearing: Fontshare serves
        // Switzer, the marketing site's typeface, and Google Fonts serves Inter
        // for the dashboard. Dropping either silently falls back to a system
        // font and changes how the site looks.
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://fonts.googleapis.com',
          'https://api.fontshare.com',
        ],
        fontSrc: [
          "'self'",
          'https://fonts.gstatic.com',
          'https://cdn.fontshare.com',
          'data:',
        ],
        imgSrc: ["'self'", 'data:'],
        connectSrc,
        frameSrc,
        upgradeInsecureRequests: config.isProduction ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: config.isProduction ? { maxAge: 15_552_000, includeSubDomains: true } : false,
  });
}

/** Redirect to HTTPS in production (Render terminates TLS at the proxy). */
export function forceHttps(req: Request, res: Response, next: NextFunction): void {
  if (!config.isProduction) return next();
  const proto = req.get('x-forwarded-proto') ?? req.protocol;
  if (proto !== 'https') {
    return res.redirect(308, `https://${req.get('host')}${req.originalUrl}`);
  }
  next();
}
