import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JoinWaitlistRequest } from '@zvault/shared';
import { ZodPipe } from '../common/zod.pipe.js';
import { WaitlistService } from './waitlist.service.js';

/**
 * The landing page's "Join the waitlist" form. The owner reads the list with
 * deploy/ec2/waitlist.sh, which also verifies joiners in SES.
 */
@Controller('waitlist')
export class WaitlistController {
  constructor(private readonly waitlist: WaitlistService) {}

  /** Always 204 for a valid form, whether the email was new, already listed, or a bot's. */
  @Post()
  @HttpCode(204)
  @Throttle({ default: { ttl: 60 * 60_000, limit: 10 } })
  async join(@Body(new ZodPipe(JoinWaitlistRequest)) body: JoinWaitlistRequest): Promise<void> {
    await this.waitlist.join(body);
  }
}
