import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { AppConfig } from '../config';
import { DB } from '../db/database';
import { CONFIG_TOKEN, DB_TOKEN } from './tokens';

export interface SentEmail { to: string; template: string; body: string; }

/**
 * Staging: 'log' prints emails to the server log (test data only).
 * Tests: 'memory' keeps them in `sent`. A real provider is added before production.
 * The outbox table records that a message was sent, never its secret content.
 */
@Injectable()
export class EmailService {
  readonly sent: SentEmail[] = [];
  constructor(@Inject(CONFIG_TOKEN) private cfg: AppConfig, @Inject(DB_TOKEN) private db: Kysely<DB>) {}

  async send(to: string, template: string, body: string): Promise<void> {
    if (this.cfg.emailDriver === 'memory') this.sent.push({ to, template, body });
    else console.log(`[email] to=${to} template=${template} :: ${body}`);
    await this.db.insertInto('notifications_outbox').values({ channel: 'email', recipient: to, template }).execute();
  }
}
