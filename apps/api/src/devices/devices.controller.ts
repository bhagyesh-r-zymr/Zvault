import {
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { DeviceSession, ListDevicesResponse, RevokeSessionsResponse } from '@zvault/shared';
import { CurrentSession, SessionGuard } from './session.guard.js';
import { SessionStore, type Session } from './session.store.js';

function toDeviceSession(s: Session, currentId: string): DeviceSession {
  return {
    id: s.id,
    device: s.device,
    createdAt: s.createdAt.toISOString(),
    lastSeenAt: s.lastSeenAt.toISOString(),
    current: s.id === currentId,
  };
}

/** Lets a signed-in user see where they are signed in and sign those devices out. */
@Controller('devices')
@UseGuards(SessionGuard)
export class DevicesController {
  constructor(private readonly sessions: SessionStore) {}

  @Get()
  async list(@CurrentSession() current: Session): Promise<ListDevicesResponse> {
    const sessions = await this.sessions.listForUser(current.userId);
    const devices = sessions
      .map((s) => toDeviceSession(s, current.id))
      .sort(
        (a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt.localeCompare(a.lastSeenAt),
      );
    return { devices };
  }

  /** Signs out one session. Revoking the current one signs this device out. */
  @Delete(':id')
  @HttpCode(204)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async revoke(
    @CurrentSession() current: Session,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<void> {
    // Another user's session id gets the same 404 as an unknown one.
    if (!(await this.sessions.revoke(current.userId, id))) throw new NotFoundException();
  }

  /** Signs out every session except the one making this request. */
  @Post('revoke-others')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async revokeOthers(@CurrentSession() current: Session): Promise<RevokeSessionsResponse> {
    return { revoked: await this.sessions.revokeAllExcept(current.userId, current.id) };
  }
}
