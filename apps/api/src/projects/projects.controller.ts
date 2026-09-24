import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CreateProjectRequest,
  DeleteEntryQuery,
  PutEnvironmentRequest,
  PutFolderRequest,
  PutSecretRequest,
  RecordId,
  SyncProjectQuery,
  UpdateProjectRequest,
  type ListProjectsResponse,
  type ProjectEntry,
  type ProjectRecord,
  type SyncProjectResponse,
} from '@zvault/shared';
import { z } from 'zod';
import { SessionGuard } from '../devices/session.guard.js';
import { CurrentUser, type AuthenticatedUser } from '../vault/current-user.js';
import { ZodPipe } from '../vault/zod.pipe.js';
import { ProjectsService } from './projects.service.js';

const Id = new ZodPipe(RecordId);
const DeleteQueryPipe = new ZodPipe(DeleteEntryQuery);
type DeleteQuery = z.infer<typeof DeleteEntryQuery>;

@Controller('projects')
@UseGuards(SessionGuard)
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser): Promise<ListProjectsResponse> {
    return { projects: await this.projects.list(user) };
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodPipe(CreateProjectRequest)) body: CreateProjectRequest,
  ): Promise<ProjectRecord> {
    return this.projects.create(user, body);
  }

  @Get(':projectId')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', Id) projectId: string,
  ): Promise<ProjectRecord> {
    return this.projects.get(user, projectId);
  }

  @Patch(':projectId')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', Id) projectId: string,
    @Body(new ZodPipe(UpdateProjectRequest)) body: UpdateProjectRequest,
  ): Promise<ProjectRecord> {
    return this.projects.update(user, projectId, body);
  }

  @Delete(':projectId')
  @HttpCode(204)
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', Id) projectId: string,
  ): Promise<void> {
    return this.projects.remove(user, projectId);
  }

  @Get(':projectId/changes')
  sync(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', Id) projectId: string,
    @Query(new ZodPipe(SyncProjectQuery)) query: z.infer<typeof SyncProjectQuery>,
  ): Promise<SyncProjectResponse> {
    return this.projects.sync(user, projectId, query.since, query.limit);
  }

  @Put(':projectId/environments/:id')
  putEnvironment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', Id) projectId: string,
    @Param('id', Id) id: string,
    @Body(new ZodPipe(PutEnvironmentRequest)) body: PutEnvironmentRequest,
  ): Promise<ProjectEntry> {
    return this.projects.putEnvironment(user, projectId, id, body);
  }

  @Delete(':projectId/environments/:id')
  deleteEnvironment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', Id) projectId: string,
    @Param('id', Id) id: string,
    @Query(DeleteQueryPipe) query: DeleteQuery,
  ): Promise<ProjectEntry> {
    return this.projects.deleteEntry(user, projectId, 'environment', id, query.baseRevision);
  }

  @Put(':projectId/folders/:id')
  putFolder(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', Id) projectId: string,
    @Param('id', Id) id: string,
    @Body(new ZodPipe(PutFolderRequest)) body: PutFolderRequest,
  ): Promise<ProjectEntry> {
    return this.projects.putFolder(user, projectId, id, body);
  }

  @Delete(':projectId/folders/:id')
  deleteFolder(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', Id) projectId: string,
    @Param('id', Id) id: string,
    @Query(DeleteQueryPipe) query: DeleteQuery,
  ): Promise<ProjectEntry> {
    return this.projects.deleteEntry(user, projectId, 'folder', id, query.baseRevision);
  }

  @Put(':projectId/secrets/:id')
  putSecret(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', Id) projectId: string,
    @Param('id', Id) id: string,
    @Body(new ZodPipe(PutSecretRequest)) body: PutSecretRequest,
  ): Promise<ProjectEntry> {
    return this.projects.putSecret(user, projectId, id, body);
  }

  @Delete(':projectId/secrets/:id')
  deleteSecret(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', Id) projectId: string,
    @Param('id', Id) id: string,
    @Query(DeleteQueryPipe) query: DeleteQuery,
  ): Promise<ProjectEntry> {
    return this.projects.deleteEntry(user, projectId, 'secret', id, query.baseRevision);
  }
}
