import {
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module.js';
import { ProjectsStore } from '../projects/projects.store.js';
import { VaultModule } from '../vault/vault.module.js';
import { trashCutoff } from '../vault/vault.service.js';
import { VaultStore } from '../vault/vault.store.js';

const SWEEP_EVERY_MS = 60 * 60 * 1000;

/**
 * Empties the trash of items and secrets deleted more than
 * `TRASH_RETENTION_DAYS` ago, once at start-up and then every hour. The trash
 * routes already hide them; this drops their ciphertext.
 */
@Injectable()
export class TrashSweeper implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TrashSweeper.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly vaults: VaultStore,
    private readonly projects: ProjectsStore,
  ) {}

  onApplicationBootstrap(): void {
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), SWEEP_EVERY_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  async sweep(now = new Date()): Promise<void> {
    const before = trashCutoff(now);
    try {
      await this.vaults.purgeExpired(before);
      await this.projects.purgeExpired(before);
    } catch (e) {
      this.logger.warn(`Trash sweep failed: ${String(e)}`);
    }
  }
}

@Module({
  imports: [VaultModule, ProjectsModule],
  providers: [TrashSweeper],
})
export class HistoryModule {}
