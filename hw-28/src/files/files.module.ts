import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { storageFromEnv } from '../storage/storage';
import { FilesController } from './files.controller';
import { FilesService, STORAGE } from './files.service';

@Module({
  imports: [AuthModule],
  providers: [FilesService, { provide: STORAGE, useFactory: storageFromEnv }],
  controllers: [FilesController],
})
export class FilesModule {}
