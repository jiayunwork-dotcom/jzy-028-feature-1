import { Module } from '@nestjs/common';
import { CfarModule } from './cfar/cfar.module';

@Module({
  imports: [CfarModule],
})
export class AppModule {}
