import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import type { AccessClaims, Role } from './tokens';

export const ROLES_KEY = 'roles';

export type AuthedRequest = Request & { user?: AccessClaims };

export function bearerToken(header: string | undefined): string | undefined {
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length).trim() || undefined;
}

/** Missing, expired, tampered or revoked token. A client reacts to 401 by refreshing. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    req.user = await this.auth.authenticate(bearerToken(req.headers.authorization));
    return true;
  }
}

/**
 * The token is valid and the role is not enough. 403, not 401: a 401 would send
 * the client into a refresh loop, and a refresh cannot grow a role.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!roles || roles.length === 0) return true;
    const user = ctx.switchToHttp().getRequest<AuthedRequest>().user;
    if (!user) throw new UnauthorizedException('unauthorized');
    if (!roles.includes(user.role)) throw new ForbiddenException('forbidden');
    return true;
  }
}
