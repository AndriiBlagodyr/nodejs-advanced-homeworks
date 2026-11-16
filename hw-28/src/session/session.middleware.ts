import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { SESSION_COOKIE, type SessionData, SessionStore } from './session.store';

export type SessionRequest = Request & { session?: { sid: string; data: SessionData } };

/** Reads the session on every request and rolls its TTL forward. */
@Injectable()
export class SessionMiddleware implements NestMiddleware {
  private readonly logger = new Logger(SessionMiddleware.name);

  constructor(private readonly store: SessionStore) {}

  async use(req: SessionRequest, res: Response, next: NextFunction): Promise<void> {
    const sid = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (sid) {
      try {
        const data = await this.store.touch(sid);
        if (data) req.session = { sid, data };
        else clearSessionCookie(req, res);
      } catch (err) {
        this.logger.warn(`session store unavailable: ${(err as Error).message}`);
      }
    }
    next();
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Secure everywhere except plain HTTP to a loopback host (the local stand).
 * Plain HTTP to any other host still gets Secure, so the browser refuses to
 * send the sid back unencrypted instead of leaking it.
 */
export function cookieAttributes(req: Request): string {
  const local = !req.secure && LOOPBACK_HOSTS.has(req.hostname);
  return `Path=/; HttpOnly; SameSite=Lax${local ? '' : '; Secure'}`;
}

export function setSessionCookie(req: Request, res: Response, sid: string): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sid}; ${cookieAttributes(req)}`);
}

export function clearSessionCookie(req: Request, res: Response): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; ${cookieAttributes(req)}; Max-Age=0`);
}
