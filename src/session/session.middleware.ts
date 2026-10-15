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
        else clearSessionCookie(res);
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

export function setSessionCookie(res: Response, sid: string): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax`);
}

export function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
