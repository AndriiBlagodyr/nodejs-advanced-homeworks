import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import type { AccessClaims } from '../auth/tokens';
import { clearSessionCookie, type SessionRequest, setSessionCookie } from './session.middleware';
import { type SessionData, SessionStore } from './session.store';

@Controller('session')
export class SessionController {
  constructor(private readonly store: SessionStore) {}

  /** Starts a server-side session for the user the access token proves. */
  @Post()
  @UseGuards(AuthGuard)
  async create(
    @Req() req: SessionRequest,
    @CurrentUser() user: AccessClaims,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Rotate on every login: never keep a session id that existed before it.
    if (req.session) await this.store.destroy(req.session.sid);
    const { sid, data } = await this.store.create(user.sub);
    setSessionCookie(req, res, sid);
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
    clearSessionCookie(req, res);
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
