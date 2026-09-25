import { Module } from '@nestjs/common';
import { WaitlistController } from './waitlist.controller.js';
import { WaitlistService } from './waitlist.service.js';

@Module({
  controllers: [WaitlistController],
  providers: [WaitlistService],
})
export class WaitlistModule {}
