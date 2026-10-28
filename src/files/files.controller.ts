import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Redirect,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import type { AccessClaims } from '../auth/tokens';
import { UploadIntentDto } from './files.dto';
import { FilesService } from './files.service';

@Controller()
@UseGuards(AuthGuard)
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post('uploads/intent')
  @HttpCode(200)
  intent(
    @Body() dto: UploadIntentDto,
    @CurrentUser() user: AccessClaims,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (idempotencyKey !== undefined && !/^[\w-]{1,128}$/.test(idempotencyKey)) {
      throw new BadRequestException('invalid Idempotency-Key');
    }
    return this.files.intent(user, { contentType: dto.contentType, size: dto.size }, idempotencyKey);
  }

  @Post('uploads/:id/resume')
  @HttpCode(200)
  resume(@Param('id') id: string, @CurrentUser() user: AccessClaims) {
    return this.files.resume(user, id);
  }

  @Post('uploads/:id/commit')
  @HttpCode(200)
  commit(@Param('id') id: string, @CurrentUser() user: AccessClaims) {
    return this.files.commit(user, id);
  }

  @Get('files/:id')
  @Redirect()
  async download(@Param('id') id: string, @CurrentUser() user: AccessClaims) {
    return { url: await this.files.downloadUrl(user, id), statusCode: 302 };
  }
}
