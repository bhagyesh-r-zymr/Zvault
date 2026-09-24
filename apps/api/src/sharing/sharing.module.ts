import { Module } from '@nestjs/common';
import { DevicesModule } from '../devices/devices.module.js';
import { SHARE_CLOCK } from './clock.js';
import { MailShareNotifier, SHARE_NOTIFIER } from './share.notifier.js';
import { InMemoryShareStore, SHARE_STORE } from './share.store.js';
import { ShareLinksService } from './share-links.service.js';
import { PublicShareLinksController, SharingController } from './sharing.controller.js';
import { UserSharesService } from './user-shares.service.js';

/** Share links and user-to-user shares, for signed-in accounts. */
@Module({
  imports: [DevicesModule],
  controllers: [PublicShareLinksController, SharingController],
  providers: [
    ShareLinksService,
    UserSharesService,
    { provide: SHARE_STORE, useClass: InMemoryShareStore },
    { provide: SHARE_NOTIFIER, useClass: MailShareNotifier },
    { provide: SHARE_CLOCK, useValue: () => new Date() },
  ],
})
export class SharingModule {}
