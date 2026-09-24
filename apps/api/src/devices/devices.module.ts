import { Module } from '@nestjs/common';
import { DevicesController } from './devices.controller.js';
import { SessionGuard } from './session.guard.js';
import { DrizzleSessionStore } from './drizzle-session.store.js';
import { SessionStore } from './session.store.js';

/**
 * Owns signed-in sessions. Exports `SessionStore` so sign-in can issue
 * sessions and `SessionGuard` so other modules can require one.
 */
@Module({
  controllers: [DevicesController],
  providers: [{ provide: SessionStore, useClass: DrizzleSessionStore }, SessionGuard],
  exports: [SessionStore, SessionGuard],
})
export class DevicesModule {}
