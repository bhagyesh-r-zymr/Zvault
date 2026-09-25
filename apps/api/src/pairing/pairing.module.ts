import { Module } from '@nestjs/common';
import { DevicesModule } from '../devices/devices.module.js';
import { PAIRING_CLOCK } from './clock.js';
import { PairingController, PhonePairingController } from './pairing.controller.js';
import { PairingService } from './pairing.service.js';
import { PairingStore } from './pairing.store.js';

/** Adding a phone by scanning a QR code on a signed-in device. */
@Module({
  imports: [DevicesModule],
  controllers: [PhonePairingController, PairingController],
  providers: [PairingService, PairingStore, { provide: PAIRING_CLOCK, useValue: () => new Date() }],
})
export class PairingModule {}
