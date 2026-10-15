import {
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import { clearSessionCookie, type SessionRequest, setSessionCookie } from './session.middleware';
import { type SessionData, SessionStore } from './session.store';

@Controller('session')
export class SessionController {
  constructor(private readonly store: SessionStore) {}

  /** Starts a session (stand-in for login until HW-24 adds auth). */
  @Post()
  async create(
    @Req() req: SessionRequest,
    @Headers('x-user-id') rawUserId: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Rotate on every login: never keep a session id that existed before it.
    if (req.session) await this.store.destroy(req.session.sid);
    const userId = rawUserId && /^\d+$/.test(rawUserId) ? rawUserId : '1';
    const { sid, data } = await this.store.create(userId);
    setSessionCookie(res, sid);
    return toBody(data);
  }

  @Get()
  current(@Req() req: SessionRequest) {
    if (!req.session) throw new UnauthorizedException('no session');
    return toBody(req.session.data);
  }

  @Delete()
  @HttpCode(204)
  async destroy(@Req() req: SessionRequest, @Res({ passthrough: true }) res: Response) {
    if (req.session) await this.store.destroy(req.session.sid);
    clearSessionCookie(res);
  }
}

function toBody(data: SessionData) {
  return {
    user_id: data.userId,
    created_at: data.createdAt,
    last_seen_at: data.lastSeenAt,
    requests: data.requests,
  };
}
