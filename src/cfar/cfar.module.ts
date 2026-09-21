import { Module } from '@nestjs/common';
import { CfarController } from './cfar.controller';
import { CfarExceptionFilter } from './cfar.exception-filter';
import { CfarService } from './cfar.service';
import { ProfileService } from './profile.service';
import { SessionController } from './session.controller';
import { SessionService } from './session.service';

@Module({
  controllers: [CfarController, SessionController],
  providers: [CfarService, ProfileService, CfarExceptionFilter, SessionService],
})
export class CfarModule {}
