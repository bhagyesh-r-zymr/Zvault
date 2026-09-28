import { Global, Inject, Injectable, Logger, Module } from '@nestjs/common';
import {
  ACTIVITY_RETENTION_DAYS,
  type ActivityAction,
  type ActivityDetail,
  type ActivityEvent,
} from '@zvault/shared';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { DATABASE, type Database } from '../db/database.js';
import { accounts, activityEvents, agents } from '../db/schema.js';

export interface ActivityRecord {
  projectId: string;
  action: ActivityAction;
  actor: { type: 'account' | 'agent'; id: string };
  environmentId?: string | null;
  targetId?: string | null;
  detail?: ActivityDetail;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Events older than this are dropped by {@link ActivityLog.sweep}. */
export const activityCutoff = (now: Date) =>
  new Date(now.getTime() - ACTIVITY_RETENTION_DAYS * DAY_MS);

/**
 * Writes and reads the team activity log. Recording never fails the request
 * that caused it: the change has already happened, so a lost event is logged
 * here instead of turning a successful write into an error.
 */
@Injectable()
export class ActivityLog {
  private readonly logger = new Logger(ActivityLog.name);

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async record(...events: ActivityRecord[]): Promise<void> {
    if (events.length === 0) return;
    try {
      await this.db.insert(activityEvents).values(
        events.map((e) => ({
          projectId: e.projectId,
          action: e.action,
          actorType: e.actor.type,
          actorId: e.actor.id,
          environmentId: e.environmentId ?? null,
          targetId: e.targetId ?? null,
          detail: e.detail ?? {},
        })),
      );
    } catch (err) {
      this.logger.warn(`Activity not recorded (${events[0]!.action}): ${String(err)}`);
    }
  }

  /** Newest first, `limit + 1` rows so callers learn whether more follow. */
  async page(
    projectId: string,
    opts: { before?: number; limit: number; targetId?: string },
  ): Promise<{ events: ActivityEvent[]; hasMore: boolean }> {
    const rows = await this.db
      .select()
      .from(activityEvents)
      .where(
        and(
          eq(activityEvents.projectId, projectId),
          opts.before !== undefined ? lt(activityEvents.seq, opts.before) : undefined,
          opts.targetId !== undefined ? eq(activityEvents.targetId, opts.targetId) : undefined,
        ),
      )
      .orderBy(desc(activityEvents.seq))
      .limit(opts.limit + 1);
    const page = rows.slice(0, opts.limit);
    const names = await this.actorNames(page);
    return {
      hasMore: rows.length > opts.limit,
      events: page.map((r) => ({
        seq: r.seq,
        at: r.at.toISOString(),
        action: r.action,
        actor: {
          type: r.actorType,
          id: r.actorId,
          name: names.get(`${r.actorType}:${r.actorId}`) ?? null,
        },
        environmentId: r.environmentId,
        targetId: r.targetId,
        detail: r.detail,
      })),
    };
  }

  async sweep(now: Date): Promise<void> {
    await this.db.delete(activityEvents).where(lt(activityEvents.at, activityCutoff(now)));
  }

  private async actorNames(rows: { actorType: string; actorId: string }[]) {
    const ids = (type: string) => [
      ...new Set(rows.filter((r) => r.actorType === type).map((r) => r.actorId)),
    ];
    const out = new Map<string, string>();
    const [a, ag] = [ids('account'), ids('agent')];
    if (a.length) {
      for (const r of await this.db
        .select({ id: accounts.id, name: accounts.email })
        .from(accounts)
        .where(inArray(accounts.id, a))) {
        out.set(`account:${r.id}`, r.name);
      }
    }
    if (ag.length) {
      for (const r of await this.db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(inArray(agents.id, ag))) {
        out.set(`agent:${r.id}`, r.name);
      }
    }
    return out;
  }
}

/** Global, so any module can record events without importing this one. */
@Global()
@Module({ providers: [ActivityLog], exports: [ActivityLog] })
export class ActivityLogModule {}
