/**
 * One-time setup (T-005): creates the single main admin and prints an invitation link.
 * Usage: DATABASE_URL=... MAIN_ADMIN_EMAIL=you@x.jo MAIN_ADMIN_NAME="Malek Abu Rahma" npm run setup:main-admin
 */
import { sql } from 'kysely';
import { randomToken, sha256 } from '../common/crypto';
import { createDb } from '../db/database';
import { migrate } from '../db/migrate';

async function main() {
  const url = process.env.DATABASE_URL, email = process.env.MAIN_ADMIN_EMAIL, name = process.env.MAIN_ADMIN_NAME;
  if (!url || !email || !name) throw new Error('Set DATABASE_URL, MAIN_ADMIN_EMAIL and MAIN_ADMIN_NAME');
  await migrate(url, false);
  const db = createDb(url);
  const existing = await db.selectFrom('staff').select('email').where('is_main_admin', '=', true).executeTakeFirst();
  if (existing) { console.log(`Main admin already exists (${existing.email}). Nothing changed.`); await db.destroy(); return; }
  const token = randomToken();
  await db.transaction().execute(async (trx) => {
    const s = await trx.insertInto('staff').values({ email, full_name: name, role: 'admin', is_main_admin: true, password_hash: null, locked_until: null }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('staff_invitations').values({ staff_id: s.id, token_hash: sha256(token), expires_at: new Date(Date.now() + 24 * 3600_000) }).execute();
    await sql`INSERT INTO audit_log (actor_type, action, record_type, record_id) VALUES ('system', 'staff.main_admin_created', 'staff', ${s.id})`.execute(trx);
  });
  console.log(`Main admin created. Set your password within 24 hours with token:\n${token}`);
  await db.destroy();
}
main();
