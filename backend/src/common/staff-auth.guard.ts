import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Kysely } from 'kysely';
import { DB } from '../db/database';
import { notAllowed, notSignedIn } from './errors';
import { can, Permission, Role } from './permissions';
import { DB_TOKEN } from './tokens';

export interface StaffUser { id: string; email: string; fullName: string; role: Role | null; isMainAdmin: boolean; }
export const REQUIRE = 'require_permission';
/** Marks an endpoint with the permission it needs. */
export const Require = (p: Permission) => SetMetadata(REQUIRE, p);

/**
 * Checks the staff token AND reloads the staff row on every request,
 * so a removed role or deactivation takes effect immediately (T-007 AC).
 */
@Injectable()
export class StaffAuthGuard implements CanActivate {
  constructor(private jwt: JwtService, private reflector: Reflector, @Inject(DB_TOKEN) private db: Kysely<DB>) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) throw notSignedIn();
    let payload: { sub: string; aud: string };
    try {
      payload = await this.jwt.verifyAsync(header.slice(7));
    } catch {
      throw notSignedIn();
    }
    if (payload.aud !== 'staff') throw notSignedIn();
    const row = await this.db.selectFrom('staff').selectAll().where('id', '=', payload.sub).executeTakeFirst();
    if (!row || row.status !== 'active') throw notSignedIn();
    const user: StaffUser = { id: row.id, email: row.email, fullName: row.full_name, role: row.role, isMainAdmin: row.is_main_admin };
    req.staff = user;
    const needed = this.reflector.get<Permission | undefined>(REQUIRE, ctx.getHandler());
    if (needed && !can(user.role, needed)) throw notAllowed();
    return true;
  }
}
