import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthGuard, RolesGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { AccessTokens } from './tokens';

@Module({
  controllers: [AuthController],
  providers: [AuthService, AccessTokens, AuthGuard, RolesGuard],
  exports: [AuthService, AuthGuard, RolesGuard, AccessTokens],
})
export class AuthModule {}
