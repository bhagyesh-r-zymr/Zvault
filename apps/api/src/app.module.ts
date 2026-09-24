import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { DevicesModule } from './devices/devices.module.js';
import { HealthController } from './health/health.controller.js';
import { MetaController } from './meta/meta.controller.js';

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]), DevicesModule],
  controllers: [HealthController, MetaController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
