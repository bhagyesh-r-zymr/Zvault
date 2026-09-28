import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AccessModule } from './access/access.module.js';
import { ActivityLogModule } from './activity/activity.log.js';
import { ActivityModule } from './activity/activity.module.js';
import { AuthModule } from './auth/auth.module.js';
import { SessionUserResolver } from './auth/session-user.resolver.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './db/database.module.js';
import { DevicesModule } from './devices/devices.module.js';
import { HealthController } from './health/health.controller.js';
import { HistoryModule } from './history/trash-sweeper.js';
import { MailModule } from './mail/mail.module.js';
import { MetaController } from './meta/meta.controller.js';
import { PairingModule } from './pairing/pairing.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { SharingModule } from './sharing/sharing.module.js';
import { TokensModule } from './tokens/tokens.module.js';
import { DrizzleTwoFactorRepository } from './two-factor/drizzle-two-factor.repository.js';
import { TwoFactorModule } from './two-factor/two-factor.module.js';
import { VaultModule } from './vault/vault.module.js';
import { WaitlistModule } from './waitlist/waitlist.module.js';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    ActivityLogModule,
    MailModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    DevicesModule,
    AuthModule,
    TwoFactorModule.forRoot({
      imports: [DevicesModule],
      repository: DrizzleTwoFactorRepository,
      userResolver: SessionUserResolver,
    }),
    VaultModule,
    ProjectsModule,
    HistoryModule,
    SharingModule,
    AccessModule,
    ActivityModule,
    PairingModule,
    TokensModule,
    WaitlistModule,
  ],
  controllers: [HealthController, MetaController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
