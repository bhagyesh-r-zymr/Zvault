import { Module } from '@nestjs/common';
import { SHARE_CLOCK } from './clock.js';
import { LoggingShareNotifier, SHARE_NOTIFIER } from './share.notifier.js';
import { InMemoryShareStore, SHARE_STORE } from './share.store.js';
import { ShareLinksService } from './share-links.service.js';
import { PublicShareLinksController, SharingController } from './sharing.controller.js';
import { UserSharesService } from './user-shares.service.js';

/**
 * Share links and user-to-user shares. Expects the auth layer to set
 * `request.user` ({ id, email }) on authenticated requests.
 */
@Module({
  controllers: [PublicShareLinksController, SharingController],
  providers: [
    ShareLinksService,
    UserSharesService,
    { provide: SHARE_STORE, useClass: InMemoryShareStore },
    { provide: SHARE_NOTIFIER, useClass: LoggingShareNotifier },
    { provide: SHARE_CLOCK, useValue: () => new Date() },
  ],
})
export class SharingModule {}
