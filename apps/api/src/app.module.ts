import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { HealthController } from './health/health.controller.js';
import { MetaController } from './meta/meta.controller.js';
import { TwoFactorModule } from './two-factor/two-factor.module.js';

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]), TwoFactorModule.forRoot()],
  controllers: [HealthController, MetaController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
