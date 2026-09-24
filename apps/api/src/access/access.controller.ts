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
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  AcceptInviteRequest,
  AddWrapsRequest,
  ApproveAccessRequest,
  ChangeRoleRequest,
  CreateAccessRequest,
  CreateGroupRequest,
  CreateOrgRequest,
  InviteMemberRequest,
  PrincipalType,
  PutGrantRequest,
  RegisterAgentRequest,
  RegisterEnvironmentRequest,
  RotateEnvironmentKeyRequest,
  type AccessRequestView,
  type EnvironmentAccess,
  type Grant,
  type ListAccessRequestsResponse,
  type ListOrgsResponse,
  type MyEnvironmentKeysResponse,
  type OrgAgent,
  type OrgDetail,
  type OrgGroup,
  type OrgMember,
  type ProjectAccessResponse,
} from '@zvault/shared';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import { CurrentSession, SessionGuard } from '../devices/session.guard.js';
import type { Session } from '../devices/session.store.js';
import { EnvironmentsService } from './environments.service.js';
import { OrgsService } from './orgs.service.js';

const Id = new ZodPipe(z.uuid());
const Type = new ZodPipe(PrincipalType);

/** Organizations, members, groups and agents. */
@Controller('orgs')
@UseGuards(SessionGuard)
export class OrgsController {
  constructor(private readonly orgs: OrgsService) {}

  @Post()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  create(
    @CurrentSession() s: Session,
    @Body(new ZodPipe(CreateOrgRequest)) body: CreateOrgRequest,
  ): Promise<OrgDetail> {
    return this.orgs.create(s.userId, body);
  }

  @Get()
  list(@CurrentSession() s: Session): Promise<ListOrgsResponse> {
    return this.orgs.list(s.userId);
  }

  @Get(':orgId')
  detail(@CurrentSession() s: Session, @Param('orgId', Id) orgId: string): Promise<OrgDetail> {
    return this.orgs.detail(orgId, s.userId);
  }

  @Post(':orgId/members')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  invite(
    @CurrentSession() s: Session,
    @Param('orgId', Id) orgId: string,
    @Body(new ZodPipe(InviteMemberRequest)) body: InviteMemberRequest,
  ): Promise<OrgMember> {
    return this.orgs.invite(orgId, s.userId, body);
  }

  @Post(':orgId/join')
  @HttpCode(200)
  accept(
    @CurrentSession() s: Session,
    @Param('orgId', Id) orgId: string,
    @Body(new ZodPipe(AcceptInviteRequest)) body: AcceptInviteRequest,
  ): Promise<OrgDetail> {
    return this.orgs.accept(orgId, s.userId, body);
  }

  @Patch(':orgId/members/:accountId')
  @HttpCode(204)
  async changeRole(
    @CurrentSession() s: Session,
    @Param('orgId', Id) orgId: string,
    @Param('accountId', Id) accountId: string,
    @Body(new ZodPipe(ChangeRoleRequest)) body: ChangeRoleRequest,
  ): Promise<void> {
    await this.orgs.changeRole(orgId, s.userId, accountId, body.role);
  }

  @Delete(':orgId/members/:accountId')
  @HttpCode(204)
  async remove(
    @CurrentSession() s: Session,
    @Param('orgId', Id) orgId: string,
    @Param('accountId', Id) accountId: string,
  ): Promise<void> {
    await this.orgs.remove(orgId, s.userId, accountId);
  }

  @Post(':orgId/groups')
  createGroup(
    @CurrentSession() s: Session,
    @Param('orgId', Id) orgId: string,
    @Body(new ZodPipe(CreateGroupRequest)) body: CreateGroupRequest,
  ): Promise<OrgGroup> {
    return this.orgs.createGroup(orgId, s.userId, body);
  }

  @Delete(':orgId/groups/:groupId')
  @HttpCode(204)
  async deleteGroup(
    @CurrentSession() s: Session,
    @Param('orgId', Id) orgId: string,
    @Param('groupId', Id) groupId: string,
  ): Promise<void> {
    await this.orgs.deleteGroup(orgId, s.userId, groupId);
  }

  @Put(':orgId/groups/:groupId/members/:accountId')
  @HttpCode(204)
  async addToGroup(
    @CurrentSession() s: Session,
    @Param('orgId', Id) orgId: string,
    @Param('groupId', Id) groupId: string,
    @Param('accountId', Id) accountId: string,
  ): Promise<void> {
    await this.orgs.addToGroup(orgId, s.userId, groupId, accountId);
  }

  @Delete(':orgId/groups/:groupId/members/:accountId')
  @HttpCode(204)
  async removeFromGroup(
    @CurrentSession() s: Session,
    @Param('orgId', Id) orgId: string,
    @Param('groupId', Id) groupId: string,
    @Param('accountId', Id) accountId: string,
  ): Promise<void> {
    await this.orgs.removeFromGroup(orgId, s.userId, groupId, accountId);
  }

  @Post(':orgId/agents')
  registerAgent(
    @CurrentSession() s: Session,
    @Param('orgId', Id) orgId: string,
    @Body(new ZodPipe(RegisterAgentRequest)) body: RegisterAgentRequest,
  ): Promise<OrgAgent> {
    return this.orgs.registerAgent(orgId, s.userId, body);
  }

  @Delete(':orgId/agents/:agentId')
  @HttpCode(204)
  async removeAgent(
    @CurrentSession() s: Session,
    @Param('orgId', Id) orgId: string,
    @Param('agentId', Id) agentId: string,
  ): Promise<void> {
    await this.orgs.removeAgent(orgId, s.userId, agentId);
  }
}

/** Per-environment access, wrapped keys, and approval requests. */
@Controller('access')
@UseGuards(SessionGuard)
export class AccessController {
  constructor(private readonly envs: EnvironmentsService) {}

  @Post('environments')
  register(
    @CurrentSession() s: Session,
    @Body(new ZodPipe(RegisterEnvironmentRequest)) body: RegisterEnvironmentRequest,
  ): Promise<EnvironmentAccess> {
    return this.envs.register(s.userId, body);
  }

  @Get('projects/:projectId')
  project(
    @CurrentSession() s: Session,
    @Param('projectId', Id) projectId: string,
  ): Promise<ProjectAccessResponse> {
    return this.envs.project(s.userId, projectId);
  }

  @Get('environments/:envId')
  detail(
    @CurrentSession() s: Session,
    @Param('envId', Id) envId: string,
  ): Promise<EnvironmentAccess> {
    return this.envs.detail(s.userId, envId);
  }

  @Put('environments/:envId/grants')
  putGrant(
    @CurrentSession() s: Session,
    @Param('envId', Id) envId: string,
    @Body(new ZodPipe(PutGrantRequest)) body: PutGrantRequest,
  ): Promise<Grant> {
    return this.envs.putGrant(s.userId, envId, body);
  }

  @Delete('environments/:envId/grants/:type/:principalId')
  @HttpCode(204)
  async deleteGrant(
    @CurrentSession() s: Session,
    @Param('envId', Id) envId: string,
    @Param('type', Type) type: PrincipalType,
    @Param('principalId', Id) principalId: string,
  ): Promise<void> {
    await this.envs.deleteGrant(s.userId, envId, { type, id: principalId });
  }

  @Get('environments/:envId/keys/me')
  myKeys(
    @CurrentSession() s: Session,
    @Param('envId', Id) envId: string,
  ): Promise<MyEnvironmentKeysResponse> {
    return this.envs.myKeys({ type: 'account', id: s.userId }, envId);
  }

  @Post('environments/:envId/keys')
  @HttpCode(204)
  async addWraps(
    @CurrentSession() s: Session,
    @Param('envId', Id) envId: string,
    @Body(new ZodPipe(AddWrapsRequest)) body: AddWrapsRequest,
  ): Promise<void> {
    await this.envs.addWraps(s.userId, envId, body);
  }

  @Post('environments/:envId/rotate')
  @HttpCode(200)
  rotate(
    @CurrentSession() s: Session,
    @Param('envId', Id) envId: string,
    @Body(new ZodPipe(RotateEnvironmentKeyRequest)) body: RotateEnvironmentKeyRequest,
  ): Promise<EnvironmentAccess> {
    return this.envs.rotate(s.userId, envId, body);
  }

  @Post('environments/:envId/requests')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  createRequest(
    @CurrentSession() s: Session,
    @Param('envId', Id) envId: string,
    @Body(new ZodPipe(CreateAccessRequest)) body: CreateAccessRequest,
  ): Promise<AccessRequestView> {
    return this.envs.createRequest({ type: 'account', id: s.userId }, envId, body);
  }

  @Get('environments/:envId/requests')
  listRequests(
    @CurrentSession() s: Session,
    @Param('envId', Id) envId: string,
  ): Promise<ListAccessRequestsResponse> {
    return this.envs.listRequests(s.userId, envId);
  }

  @Get('requests/:requestId')
  getRequest(
    @CurrentSession() s: Session,
    @Param('requestId', Id) requestId: string,
  ): Promise<AccessRequestView> {
    return this.envs.getRequest({ type: 'account', id: s.userId }, requestId);
  }

  @Post('requests/:requestId/approve')
  @HttpCode(200)
  approve(
    @CurrentSession() s: Session,
    @Param('requestId', Id) requestId: string,
    @Body(new ZodPipe(ApproveAccessRequest)) body: ApproveAccessRequest,
  ): Promise<AccessRequestView> {
    return this.envs.approve(s.userId, requestId, body);
  }

  @Post('requests/:requestId/deny')
  @HttpCode(200)
  deny(
    @CurrentSession() s: Session,
    @Param('requestId', Id) requestId: string,
  ): Promise<AccessRequestView> {
    return this.envs.deny(s.userId, requestId);
  }
}
