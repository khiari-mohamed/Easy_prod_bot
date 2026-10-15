import { Module } from '@nestjs/common';
import { TikTokController } from './tiktok.controller';

@Module({ controllers: [TikTokController] })
export class TikTokModule {}
