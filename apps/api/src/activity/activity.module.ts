import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ActivityPageQuery,
  RecordId,
  ReportActivityRequest,
  type ActivityPageResponse,
} from '@zvault/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { AccessModule } from '../access/access.module.js';
import { ProjectPolicy } from '../access/project-policy.js';
import { DATABASE, type Database } from '../db/database.js';
import { projectEntries } from '../db/schema.js';
import { DevicesModule } from '../devices/devices.module.js';
import { SessionGuard } from '../devices/session.guard.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { ProjectsStore } from '../projects/projects.store.js';
import { CurrentUser, type AuthenticatedUser } from '../vault/current-user.js';
import { ZodPipe } from '../vault/zod.pipe.js';
import { ActivityLog } from './activity.log.js';

const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;

@Injectable()
export class ActivityService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly log: ActivityLog,
    private readonly store: ProjectsStore,
    private readonly policy: ProjectPolicy,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  onApplicationBootstrap(): void {
    const sweep = () => void this.log.sweep(new Date()).catch(() => undefined);
    sweep();
    this.timer = setInterval(sweep, SWEEP_EVERY_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  async page(
    user: AuthenticatedUser,
    projectId: string,
    query: ActivityPageQuery,
  ): Promise<ActivityPageResponse> {
    const access = await this.member(user, projectId);
    if (!(await this.policy.canSeeActivity(projectId, user.id, access.ownerId))) {
      throw new ForbiddenException({ error: 'managers_only' });
    }
    return this.log.page(projectId, {
      limit: query.limit,
      ...(query.before !== undefined && { before: query.before }),
      ...(query.secretId !== undefined && { targetId: query.secretId }),
    });
  }

  /**
   * Views, copies, shares and agent use happen on a device. Only someone
   * holding an environment's key can do them, so only they can report them.
   */
  async report(
    user: AuthenticatedUser,
    projectId: string,
    req: ReportActivityRequest,
  ): Promise<void> {
    const access = await this.member(user, projectId);
    if (req.events.some((e) => !access.environments.has(e.environmentId))) {
      throw new ForbiddenException({ error: 'no_access' });
    }
    const secretIds = [...new Set(req.events.map((e) => e.secretId))];
    const known = await this.db
      .select({ id: projectEntries.id })
      .from(projectEntries)
      .where(
        and(
          eq(projectEntries.projectId, projectId),
          eq(projectEntries.type, 'secret'),
          inArray(projectEntries.id, secretIds),
        ),
      );
    if (known.length !== secretIds.length) throw new NotFoundException({ error: 'unknown_secret' });
    await this.log.record(
      ...req.events.map((e) => ({
        projectId,
        action: e.action,
        actor: { type: 'account' as const, id: user.id },
        environmentId: e.environmentId,
        targetId: e.secretId,
        detail: {
          ...(e.share && { share: e.share }),
          ...(e.agent && { agent: e.agent }),
        },
      })),
    );
  }

  /** Non-members get 404, as in the projects API. */
  private async member(user: AuthenticatedUser, projectId: string) {
    await this.policy.beforeAccess(projectId);
    const access = await this.store.getAccess(projectId, user.id);
    if (!access?.member) throw new NotFoundException();
    return access;
  }
}

const Id = new ZodPipe(RecordId);

/** A project's team activity log. */
@Controller('projects/:projectId/activity')
@UseGuards(SessionGuard)
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get()
  page(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', Id) projectId: string,
    @Query(new ZodPipe(ActivityPageQuery)) query: ActivityPageQuery,
  ): Promise<ActivityPageResponse> {
    return this.activity.page(user, projectId, query);
  }

  @Post()
  @HttpCode(204)
  @Throttle({ default: { ttl: 60_000, limit: 120 } })
  async report(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', Id) projectId: string,
    @Body(new ZodPipe(ReportActivityRequest)) body: ReportActivityRequest,
  ): Promise<void> {
    await this.activity.report(user, projectId, body);
  }
}

@Module({
  imports: [DevicesModule, AccessModule, ProjectsModule],
  controllers: [ActivityController],
  providers: [ActivityService],
})
export class ActivityModule {}
