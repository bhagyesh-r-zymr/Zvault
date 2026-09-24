import { Module } from '@nestjs/common';
import { DevicesModule } from '../devices/devices.module.js';
import { AccessFacts } from './access.facts.js';
import { AccessController, OrgsController } from './access.controller.js';
import { ACCESS_CLOCK } from './clock.js';
import { EnvironmentsService } from './environments.service.js';
import { OrgsService } from './orgs.service.js';
import { ProjectPolicy } from './project-policy.js';

/**
 * Team access: organizations, members, groups, agents, per-environment grants,
 * wrapped environment keys and approval requests. Exports
 * `EnvironmentsService.require` (a principal's level in an environment) and
 * `ProjectPolicy` (team rules the projects API applies).
 */
@Module({
  imports: [DevicesModule],
  controllers: [OrgsController, AccessController],
  providers: [
    AccessFacts,
    OrgsService,
    EnvironmentsService,
    ProjectPolicy,
    { provide: ACCESS_CLOCK, useValue: () => new Date() },
  ],
  exports: [EnvironmentsService, ProjectPolicy],
})
export class AccessModule {}
