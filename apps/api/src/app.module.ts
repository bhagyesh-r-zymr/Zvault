import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { HealthController } from './health/health.controller.js';
import { MetaController } from './meta/meta.controller.js';
import { VaultModule } from './vault/vault.module.js';

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]), VaultModule],
  controllers: [HealthController, MetaController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
