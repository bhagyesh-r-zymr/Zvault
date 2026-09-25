import { Inject, Injectable, Logger } from '@nestjs/common';
import type { JoinWaitlistRequest } from '@zvault/shared';
import { count } from 'drizzle-orm';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DATABASE, type Database } from '../db/database.js';
import { waitlist } from '../db/schema.js';
import { Mailer } from '../mail/mailer.js';
import { waitlistJoinedEmail } from '../mail/templates.js';

@Injectable()
export class WaitlistService {
  private readonly logger = new Logger('Waitlist');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly mailer: Mailer,
  ) {}

  /**
   * Adds someone to the waitlist. Joining again with the same email changes
   * nothing, and the caller can't tell the difference, so the form can't be
   * used to learn who is on the list.
   */
  async join(req: JoinWaitlistRequest): Promise<void> {
    if (req.website) return; // Honeypot filled: a bot.
    const inserted = await this.db
      .insert(waitlist)
      .values({ email: req.email, name: req.name, note: req.note })
      .onConflictDoNothing({ target: waitlist.email })
      .returning({ id: waitlist.id });
    if (inserted.length === 0) return;

    const owner = this.env.WAITLIST_OWNER_EMAIL;
    if (!owner) return;
    const [{ total } = { total: 0 }] = await this.db.select({ total: count() }).from(waitlist);
    // Don't make the visitor wait on (or learn from) the mail server.
    this.mailer
      .send(waitlistJoinedEmail(owner, req.email, total))
      .catch((e: unknown) => this.logger.error(`Could not send waitlist notice: ${String(e)}`));
  }
}
