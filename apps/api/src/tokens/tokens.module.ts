import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { DevicesModule } from '../devices/devices.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { TokenActivity } from './token-activity.js';
import { ProjectTokensController, TokenController } from './tokens.controller.js';
import { TokensService } from './tokens.service.js';

/**
 * Read-only access tokens for cloud agents and CI. Exports `TokenActivity`,
 * the hook where issuing, using, denying and revoking a token is reported.
 */
@Module({
  imports: [DevicesModule, AccessModule, ProjectsModule],
  controllers: [ProjectTokensController, TokenController],
  providers: [TokensService, TokenActivity],
  exports: [TokenActivity],
})
export class TokensModule {}
