import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AccessModule } from './access/access.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './db/database.module.js';
import { DevicesModule } from './devices/devices.module.js';
import { HealthController } from './health/health.controller.js';
import { MailModule } from './mail/mail.module.js';
import { MetaController } from './meta/meta.controller.js';
import { SharingModule } from './sharing/sharing.module.js';
import { TwoFactorModule } from './two-factor/two-factor.module.js';
import { VaultModule } from './vault/vault.module.js';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    MailModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    DevicesModule,
    AuthModule,
    TwoFactorModule.forRoot(),
    VaultModule,
    SharingModule,
    AccessModule,
  ],
  controllers: [HealthController, MetaController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
