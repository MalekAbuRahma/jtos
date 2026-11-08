import { Kysely } from 'kysely';
import { DB, DocType } from '../db/database';

/** Latest usable document per type: approved ones, or pending ones (before first approval). */
export async function currentDocs(db: Kysely<DB>, driverId: string, statuses: ('approved' | 'pending')[]) {
  const rows = await db.selectFrom('driver_documents').selectAll().where('driver_id', '=', driverId)
    .where('status', 'in', statuses).orderBy('created_at', 'desc').execute();
  const out: Partial<Record<DocType, (typeof rows)[number]>> = {};
  for (const r of rows) if (!out[r.type]) out[r.type] = r;
  return out;
}
