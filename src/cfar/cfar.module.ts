import { Module } from '@nestjs/common';
import { CfarController } from './cfar.controller';
import { CfarExceptionFilter } from './cfar.exception-filter';
import { CfarService } from './cfar.service';
import { ProfileService } from './profile.service';

@Module({
  controllers: [CfarController],
  providers: [CfarService, ProfileService, CfarExceptionFilter],
})
export class CfarModule {}
