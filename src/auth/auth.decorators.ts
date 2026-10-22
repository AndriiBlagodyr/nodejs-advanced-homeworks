import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import { ROLES_KEY, type AuthedRequest } from './auth.guard';
import type { AccessClaims, Role } from './tokens';

export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AccessClaims => {
    const user = ctx.switchToHttp().getRequest<AuthedRequest>().user;
    if (!user) throw new Error('CurrentUser used without AuthGuard');
    return user;
  },
);
