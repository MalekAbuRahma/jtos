import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { AppConfig } from '../config';
import { DB } from '../db/database';
import { CONFIG_TOKEN, DB_TOKEN } from './tokens';

export type Channel = 'whatsapp' | 'sms' | 'push' | 'email';
export interface SentMessage { channel: Channel; to: string; template: string; body: string; recipientId?: string; }

/**
 * WhatsApp / SMS / push to passengers and drivers.
 * Staging: printed to the server log. Tests: kept in memory. Real providers come later.
 * The outbox records that a message was sent — never its content (codes stay secret).
 */
@Injectable()
export class MessagingService {
  readonly sent: SentMessage[] = [];
  constructor(@Inject(CONFIG_TOKEN) private cfg: AppConfig, @Inject(DB_TOKEN) private db: Kysely<DB>) {}

  async send(m: SentMessage & { recipientType?: 'passenger' | 'driver' | 'staff' }): Promise<void> {
    if (this.cfg.emailDriver === 'memory') this.sent.push(m);
    else console.log(`[${m.channel}] to=${m.to} template=${m.template} :: ${m.body}`);
    await this.db.insertInto('notifications_outbox').values({
      channel: m.channel, recipient: m.to, template: m.template,
      recipient_type: m.recipientType ?? null, recipient_id: m.recipientId ?? null,
    }).execute();
  }
}
