import { Module } from '@nestjs/common';
import { VaultController } from './vault.controller.js';
import { VaultService } from './vault.service.js';
import { InMemoryVaultStore, VaultStore } from './vault.store.js';

@Module({
  controllers: [VaultController],
  providers: [VaultService, { provide: VaultStore, useClass: InMemoryVaultStore }],
  exports: [VaultService],
})
export class VaultModule {}
