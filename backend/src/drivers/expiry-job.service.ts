import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { addDays, daysBetween, jordanDate } from '../common/dates';
import { MessagingService } from '../common/messaging.service';
import { DB_TOKEN } from '../common/tokens';
import { DB } from '../db/database';
import { SettingsService } from '../settings/settings.service';
import { DOC_LABELS } from './rules';

/** T-002 TC-10 / T-004 TC-09: one push per document, 30 days (setting) before it expires — not earlier. */
@Injectable()
export class ExpiryJobService {
  constructor(@Inject(DB_TOKEN) private db: Kysely<DB>, private settings: SettingsService, private messaging: MessagingService) {}

  async run(now: Date = new Date()): Promise<number> {
    const today = jordanDate(now);
    const { values } = await this.settings.versionAt(now);
    const until = addDays(today, values.documentWarningDays as number);
    const due = await this.db.selectFrom('driver_documents as d').innerJoin('drivers as r', 'r.id', 'd.driver_id')
      .select(['d.id', 'd.type', 'd.expires_at', 'r.id as driverId', 'r.phone'])
      .where('d.status', '=', 'approved').where('d.expiry_warned_at', 'is', null)
      .where('d.expires_at', '>=', today).where('d.expires_at', '<=', until).execute();
    for (const d of due) {
      const left = daysBetween(today, d.expires_at!);
      await this.messaging.send({ channel: 'push', to: d.phone, recipientType: 'driver', recipientId: d.driverId, template: 'document_expiring',
        body: `Your ${DOC_LABELS[d.type].toLowerCase()} expires in ${left} days (${d.expires_at}). Upload the new one to keep publishing trips.` });
      await this.db.updateTable('driver_documents').set({ expiry_warned_at: now }).where('id', '=', d.id).execute();
    }
    return due.length;
  }
}
