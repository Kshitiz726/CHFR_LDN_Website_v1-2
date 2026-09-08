import express, { type Express } from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/env.js';
import { cookies } from './middleware/cookies.js';
import { securityHeaders, forceHttps } from './middleware/security.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { loadSession } from '../auth/middleware.js';
import { publicRouter } from './routes/public.js';
import { adminApiRouter } from './routes/adminApi.js';
import { adminUiRouter } from './routes/adminUi.js';

const here = dirname(fileURLToPath(import.meta.url));
// public/ sits at the project root, next to src/ (and next to dist/ once built).
const PUBLIC_DIR = join(here, '..', '..', 'public');

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  // Render (and any other proxy) terminates TLS, so the real protocol and IP
  // arrive in X-Forwarded-* headers.
  if (config.TRUST_PROXY || config.isProduction) app.set('trust proxy', 1);

  app.use(forceHttps);
  app.use(securityHeaders());

  // Request size caps — a booking form has no business sending more than this.
  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(cookies);
  app.use(loadSession);

  app.use('/api', publicRouter);
  app.use('/api/admin', adminApiRouter);
  app.use('/admin', adminUiRouter);

  // The existing CHFR website, served exactly as authored.
  app.use(
    express.static(PUBLIC_DIR, {
      extensions: ['html'],
      setHeaders: (res, path) => {
        if (/\.(?:css|js|jpe?g|png|webp|svg|woff2?)$/.test(path)) {
          res.setHeader('Cache-Control', 'public, max-age=3600');
        }
      },
    }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export { PUBLIC_DIR };
