import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from './auth.decorators';
import { LoginDto, RefreshDto } from './auth.dto';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import type { AccessClaims } from './tokens';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refresh_token);
  }

  /** Revokes the refresh family and denylists this access token's jti. */
  @Post('logout')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  async logout(@CurrentUser() user: AccessClaims): Promise<void> {
    await this.auth.logout(user);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@CurrentUser() user: AccessClaims) {
    return { user_id: user.sub, role: user.role };
  }
}
