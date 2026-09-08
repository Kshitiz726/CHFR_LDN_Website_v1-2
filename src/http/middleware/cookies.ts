import type { Request, Response, NextFunction } from 'express';
import { parse, serialize, type SerializeOptions } from 'cookie';

declare module 'express-serve-static-core' {
  // `cookies` is already declared by @types/express; only the helpers are new.
  interface Response {
    setCookie(name: string, value: string, options?: SerializeOptions): void;
    clearCookie2(name: string, options?: SerializeOptions): void;
  }
}

/** Minimal cookie parse/serialize — avoids pulling in cookie-parser. */
export function cookies(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.cookie;
  req.cookies = header ? (parse(header) as Record<string, string | undefined>) : {};

  res.setCookie = (name, value, options = {}) => {
    res.append('Set-Cookie', serialize(name, value, options));
  };
  res.clearCookie2 = (name, options = {}) => {
    res.append('Set-Cookie', serialize(name, '', { ...options, expires: new Date(0), maxAge: 0 }));
  };

  next();
}
