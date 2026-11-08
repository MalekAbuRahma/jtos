import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { AuditService } from '../common/audit.service';
import { badInput, conflict, notAllowed, notFound } from '../common/errors';
import { Role } from '../common/permissions';
import { StaffUser } from '../common/staff-auth.guard';
import { DB_TOKEN } from '../common/tokens';
import { DB } from '../db/database';
import { StaffAuthService } from './staff-auth.service';

const ROLES: Role[] = ['admin', 'support', 'auditor'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** T-005 create staff, T-007 assign/remove roles. Only the main admin may do these. */
@Injectable()
export class StaffService {
  constructor(@Inject(DB_TOKEN) private db: Kysely<DB>, private audit: AuditService, private auth: StaffAuthService) {}

  private requireMainAdmin(actor: StaffUser) {
    if (!actor.isMainAdmin) throw notAllowed();
  }

  list() {
    return this.db.selectFrom('staff')
      .select(['id', 'full_name as fullName', 'email', 'role', 'status', 'is_main_admin as isMainAdmin', 'created_at as createdAt'])
      .orderBy('created_at').execute();
  }

  async create(actor: StaffUser, fullName: string, email: string, ip?: string) {
    this.requireMainAdmin(actor);
    if (!fullName?.trim()) throw badInput('NAME_REQUIRED', 'Enter the full name.');
    if (!email || !EMAIL_RE.test(email)) throw badInput('BAD_EMAIL', 'Enter a valid work email.');
    const exists = await this.db.selectFrom('staff').select('id').where((eb) => eb(eb.fn('lower', ['email']), '=', email.toLowerCase())).executeTakeFirst();
    if (exists) throw conflict('EMAIL_TAKEN', 'A staff account with this email already exists.');
    const row = await this.db.transaction().execute(async (trx) => {
      const r = await trx.insertInto('staff').values({ full_name: fullName.trim(), email: email.trim(), password_hash: null, role: null, locked_until: null })
        .returning(['id', 'email', 'full_name', 'role', 'status']).executeTakeFirstOrThrow();
      await this.audit.record({ actorType: 'staff', actorId: actor.id, action: 'staff.created', recordType: 'staff', recordId: r.id, after: { fullName: r.full_name, email: r.email, role: null }, ip }, trx);
      return r;
    });
    await this.auth.createInvitation(row.id, row.email);
    return { id: row.id, fullName: row.full_name, email: row.email, role: row.role, status: row.status };
  }

  async setRole(actor: StaffUser, staffId: string, role: Role | null, ip?: string) {
    this.requireMainAdmin(actor);
    if (role !== null && !ROLES.includes(role)) throw badInput('BAD_ROLE', 'Role must be admin, support, auditor or none.');
    const target = await this.db.selectFrom('staff').selectAll().where('id', '=', staffId).executeTakeFirst().catch(() => undefined);
    if (!target) throw notFound('Staff member');
    if (target.is_main_admin) throw badInput('MAIN_ADMIN_ROLE', "The main admin's role can't be changed.");
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('staff').set({ role, updated_at: new Date() }).where('id', '=', staffId).execute();
      await this.audit.record({ actorType: 'staff', actorId: actor.id, action: 'staff.role_changed', recordType: 'staff', recordId: staffId, before: { role: target.role }, after: { role }, ip }, trx);
    });
    return { id: staffId, role };
  }

  async deactivate(actor: StaffUser, staffId: string, ip?: string) {
    this.requireMainAdmin(actor);
    const target = await this.db.selectFrom('staff').selectAll().where('id', '=', staffId).executeTakeFirst().catch(() => undefined);
    if (!target) throw notFound('Staff member');
    if (target.is_main_admin) throw badInput('MAIN_ADMIN', "The main admin can't be deactivated.");
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('staff').set({ status: 'deactivated', updated_at: new Date() }).where('id', '=', staffId).execute();
      await this.audit.record({ actorType: 'staff', actorId: actor.id, action: 'staff.deactivated', recordType: 'staff', recordId: staffId, before: { status: target.status }, after: { status: 'deactivated' }, ip }, trx);
    });
    return { id: staffId, status: 'deactivated' };
  }

  async resendInvitation(actor: StaffUser, staffId: string) {
    this.requireMainAdmin(actor);
    const t = await this.db.selectFrom('staff').selectAll().where('id', '=', staffId).executeTakeFirst().catch(() => undefined);
    if (!t) throw notFound('Staff member');
    if (t.status !== 'invited') throw badInput('NOT_INVITED', 'This person has already set a password.');
    await this.auth.createInvitation(t.id, t.email);
    return { sent: true };
  }
}
