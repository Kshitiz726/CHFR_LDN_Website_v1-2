import type { Request, Response, NextFunction } from 'express';
import { config } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { AppError, GENERIC_ERROR_MESSAGE } from '../../utils/errors.js';
import { esc } from '../../utils/html.js';

/** 404 for anything that reached the end of the stack. */
export function notFoundHandler(req: Request, res: Response): void {
  if (wantsJson(req)) {
    res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found.' } });
    return;
  }
  res.status(404).type('html').send(errorPage(404, 'Page not found', 'That page does not exist.'));
}

/**
 * Centralised error handling. Customers see friendly copy; the detail — and
 * only the detail, never a secret — goes to the structured log.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const appError = err instanceof AppError ? err : null;
  const status = appError?.statusCode ?? 500;

  if (status >= 500) {
    logger.error({ err, path: req.path, method: req.method }, 'Unhandled request error');
  } else {
    logger.warn(
      { code: appError?.code, path: req.path, method: req.method, message: appError?.message },
      'Request rejected',
    );
  }

  const message = appError && status < 500 ? appError.message : GENERIC_ERROR_MESSAGE;

  if (res.headersSent) return;

  if (wantsJson(req)) {
    res.status(status).json({
      ok: false,
      error: {
        code: appError?.code ?? 'INTERNAL_ERROR',
        message,
        ...(appError?.details ? { details: appError.details } : {}),
      },
    });
    return;
  }

  res.status(status).type('html').send(errorPage(status, titleFor(status), message));
}

function titleFor(status: number): string {
  if (status === 401) return 'Sign in required';
  if (status === 403) return 'Not permitted';
  if (status === 404) return 'Page not found';
  if (status === 429) return 'Too many requests';
  return 'Something went wrong';
}

function wantsJson(req: Request): boolean {
  return (
    req.path.startsWith('/api/') ||
    req.get('accept')?.includes('application/json') === true ||
    req.get('content-type')?.includes('application/json') === true
  );
}

function errorPage(status: number, title: string, message: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — CHFR LDN.</title>
<style>
 body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:#111;color:#f5f5f5;font:400 15px/1.6 Inter,Arial,sans-serif;padding:24px;}
 .box{max-width:460px}
 .brand{font:800 30px/1 Arial,sans-serif;letter-spacing:-1.8px;color:#ff4a5e}
 .brand span{font-size:11px;letter-spacing:1.2px;color:#f5f5f5;padding-left:6px}
 h1{font-size:26px;letter-spacing:-1px;margin:28px 0 12px}
 p{color:#a8a8a8;margin:0 0 26px}
 .code{font-size:11px;letter-spacing:2px;color:#ff4a5e;text-transform:uppercase}
 a{display:inline-block;background:#ff4a5e;color:#111;padding:14px 22px;text-decoration:none;
   font:800 12px/1 Arial,sans-serif;letter-spacing:.7px;text-transform:uppercase}
</style></head>
<body><div class="box">
  <div class="brand">CHFR<span>LDN.</span></div>
  <div class="code" style="margin-top:26px">Error ${status}</div>
  <h1>${esc(title)}</h1>
  <p>${esc(message)}</p>
  <a href="/">Return to CHFR</a>
</div></body></html>`;
}

export const developmentDetail = () => !config.isProduction;
