import { Module } from '@nestjs/common';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { UploadSessionService } from './upload-session.service';

/**
 * Media library: uploads (direct + resumable), URL imports, listing and the
 * signed display URLs. The heavy storage/processing pieces live in MediaModule,
 * which is global.
 */
@Module({
  controllers: [AssetsController],
  providers: [AssetsService, UploadSessionService],
  exports: [AssetsService],
})
export class AssetsModule {}
