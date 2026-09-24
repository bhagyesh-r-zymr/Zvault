import { Module } from '@nestjs/common';
import { DevicesModule } from '../devices/devices.module.js';
import { AccessFacts } from './access.facts.js';
import { AccessController, OrgsController } from './access.controller.js';
import { ACCESS_CLOCK } from './clock.js';
import { EnvironmentsService } from './environments.service.js';
import { OrgsService } from './orgs.service.js';

/**
 * Team access: organizations, members, groups, agents, per-environment grants,
 * wrapped environment keys and approval requests. Exports
 * `EnvironmentsService.require` so the secrets and agent modules can gate on a
 * principal's level.
 */
@Module({
  imports: [DevicesModule],
  controllers: [OrgsController, AccessController],
  providers: [
    AccessFacts,
    OrgsService,
    EnvironmentsService,
    { provide: ACCESS_CLOCK, useValue: () => new Date() },
  ],
  exports: [EnvironmentsService],
})
export class AccessModule {}
