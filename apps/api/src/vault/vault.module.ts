import { Module } from '@nestjs/common';
import { DevicesModule } from '../devices/devices.module.js';
import { DrizzleVaultStore } from './drizzle-vault.store.js';
import { VaultController } from './vault.controller.js';
import { VaultService } from './vault.service.js';
import { VaultStore } from './vault.store.js';

@Module({
  imports: [DevicesModule],
  controllers: [VaultController],
  providers: [VaultService, { provide: VaultStore, useClass: DrizzleVaultStore }],
  exports: [VaultService, VaultStore],
})
export class VaultModule {}
