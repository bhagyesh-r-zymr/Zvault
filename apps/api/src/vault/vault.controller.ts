import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CreateVaultRequest,
  DeleteItemQuery,
  PutItemRequest,
  RecordId,
  SyncItemsQuery,
  type ItemHistoryResponse,
  type ItemRecord,
  type ListVaultsResponse,
  type SyncItemsResponse,
  type VaultRecord,
  type VaultTrashResponse,
} from '@zvault/shared';
import { z } from 'zod';
import { SessionGuard } from '../devices/session.guard.js';
import { CurrentUser, type AuthenticatedUser } from './current-user.js';
import { VaultService } from './vault.service.js';
import { ZodPipe } from './zod.pipe.js';

const Id = new ZodPipe(RecordId);

@Controller('vaults')
@UseGuards(SessionGuard)
export class VaultController {
  constructor(private readonly vaults: VaultService) {}

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser): Promise<ListVaultsResponse> {
    return { vaults: await this.vaults.listVaults(user) };
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodPipe(CreateVaultRequest)) body: CreateVaultRequest,
  ): Promise<VaultRecord> {
    return this.vaults.createVault(user, body);
  }

  @Get(':vaultId/items')
  sync(
    @CurrentUser() user: AuthenticatedUser,
    @Param('vaultId', Id) vaultId: string,
    @Query(new ZodPipe(SyncItemsQuery)) query: z.infer<typeof SyncItemsQuery>,
  ): Promise<SyncItemsResponse> {
    return this.vaults.sync(user, vaultId, query.since, query.limit);
  }

  @Put(':vaultId/items/:itemId')
  put(
    @CurrentUser() user: AuthenticatedUser,
    @Param('vaultId', Id) vaultId: string,
    @Param('itemId', Id) itemId: string,
    @Body(new ZodPipe(PutItemRequest)) body: PutItemRequest,
  ): Promise<ItemRecord> {
    return this.vaults.putItem(user, vaultId, itemId, body);
  }

  @Delete(':vaultId/items/:itemId')
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('vaultId', Id) vaultId: string,
    @Param('itemId', Id) itemId: string,
    @Query(new ZodPipe(DeleteItemQuery)) query: z.infer<typeof DeleteItemQuery>,
  ): Promise<ItemRecord> {
    return this.vaults.deleteItem(user, vaultId, itemId, query.baseRevision);
  }

  @Get(':vaultId/items/:itemId/history')
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Param('vaultId', Id) vaultId: string,
    @Param('itemId', Id) itemId: string,
  ): Promise<ItemHistoryResponse> {
    return this.vaults.history(user, vaultId, itemId);
  }

  @Get(':vaultId/trash')
  trash(
    @CurrentUser() user: AuthenticatedUser,
    @Param('vaultId', Id) vaultId: string,
  ): Promise<VaultTrashResponse> {
    return this.vaults.trash(user, vaultId);
  }

  @Delete(':vaultId/trash')
  @HttpCode(204)
  emptyTrash(
    @CurrentUser() user: AuthenticatedUser,
    @Param('vaultId', Id) vaultId: string,
  ): Promise<void> {
    return this.vaults.purge(user, vaultId, null);
  }

  @Delete(':vaultId/trash/:itemId')
  @HttpCode(204)
  purge(
    @CurrentUser() user: AuthenticatedUser,
    @Param('vaultId', Id) vaultId: string,
    @Param('itemId', Id) itemId: string,
  ): Promise<void> {
    return this.vaults.purge(user, vaultId, itemId);
  }
}
