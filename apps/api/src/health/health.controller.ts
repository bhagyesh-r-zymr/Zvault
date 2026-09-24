import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { HealthResponse } from '@zvault/shared';

@Controller('health')
@SkipThrottle()
export class HealthController {
  @Get()
  check(): HealthResponse {
    return { status: 'ok', version: process.env.npm_package_version ?? '0.0.0' };
  }
}
