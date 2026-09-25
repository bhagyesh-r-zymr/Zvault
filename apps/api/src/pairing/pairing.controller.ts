import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApprovePairingRequest,
  ClaimPairingRequest,
  CreatePairingRequest,
  PairingResultRequest,
  type CreatePairingResponse,
  type PairingResultResponse,
  type PairingView,
} from '@zvault/shared';
import type { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import { CurrentSession, SessionGuard } from '../devices/session.guard.js';
import type { Session } from '../devices/session.store.js';
import { PairingService } from './pairing.service.js';

const Id = new ParseUUIDPipe({ version: '4' });

/** The signed-in device's side: show a QR code, then allow or deny the phone. */
@Controller('pairings')
@UseGuards(SessionGuard)
export class PairingController {
  constructor(private readonly pairing: PairingService) {}

  @Post()
  @HttpCode(201)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  create(
    @CurrentSession() session: Session,
    @Body(new ZodPipe(CreatePairingRequest)) body: z.output<typeof CreatePairingRequest>,
  ): CreatePairingResponse {
    return this.pairing.create(session.userId, body.claimToken);
  }

  @Get(':id')
  view(@CurrentSession() session: Session, @Param('id', Id) id: string): PairingView {
    return this.pairing.view(session.userId, id);
  }

  @Post(':id/approve')
  @HttpCode(204)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async approve(
    @CurrentSession() session: Session,
    @Param('id', Id) id: string,
    @Body(new ZodPipe(ApprovePairingRequest)) body: z.output<typeof ApprovePairingRequest>,
  ): Promise<void> {
    await this.pairing.approve(session.userId, id, body.grant);
  }

  @Post(':id/deny')
  @HttpCode(204)
  deny(@CurrentSession() session: Session, @Param('id', Id) id: string): void {
    this.pairing.deny(session.userId, id);
  }
}

/** The phone's side. It has no session yet; the claim token proves it saw the QR code. */
@Controller('pairings')
@Throttle({ default: { ttl: 60_000, limit: 30 } })
export class PhonePairingController {
  constructor(private readonly pairing: PairingService) {}

  @Post(':id/claim')
  @HttpCode(204)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  claim(
    @Param('id', Id) id: string,
    @Body(new ZodPipe(ClaimPairingRequest)) body: z.output<typeof ClaimPairingRequest>,
  ): void {
    this.pairing.claim(id, body);
  }

  @Post(':id/result')
  @HttpCode(200)
  result(
    @Param('id', Id) id: string,
    @Body(new ZodPipe(PairingResultRequest)) body: z.output<typeof PairingResultRequest>,
  ): PairingResultResponse {
    return this.pairing.result(id, body.claimToken);
  }
}
