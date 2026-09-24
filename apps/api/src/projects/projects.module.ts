import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { DevicesModule } from '../devices/devices.module.js';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';
import { ProjectsStore } from './projects.store.js';

/**
 * Projects of secrets, their environments, folders and key grants. Exports
 * the store so team access can add and remove key grants for members.
 */
@Module({
  imports: [DevicesModule, AccessModule],
  controllers: [ProjectsController],
  providers: [ProjectsService, ProjectsStore],
  exports: [ProjectsService, ProjectsStore],
})
export class ProjectsModule {}
