import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Kysely } from 'kysely';
import { DB } from '../db/database';
import { notAllowed, notSignedIn } from './errors';
import { DB_TOKEN } from './tokens';

async function readToken(jwt: JwtService, req: any, aud: string): Promise<string> {
  const header: string | undefined = req.headers['authorization'];
  if (!header?.startsWith('Bearer ')) throw notSignedIn();
  try {
    const p = await jwt.verifyAsync(header.slice(7));
    if (p.aud !== aud) throw new Error();
    return p.sub;
  } catch { throw notSignedIn(); }
}

/** Passenger app token. Blocked accounts are refused. */
@Injectable()
export class PassengerAuthGuard implements CanActivate {
  constructor(private jwt: JwtService, @Inject(DB_TOKEN) private db: Kysely<DB>) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const id = await readToken(this.jwt, req, 'passenger');
    const p = await this.db.selectFrom('passengers').selectAll().where('id', '=', id).executeTakeFirst();
    if (!p) throw notSignedIn();
    if (p.status === 'blocked') throw notAllowed();
    req.passenger = p;
    return true;
  }
}

/** Driver app token. Suspended drivers can still sign in to see why. */
@Injectable()
export class DriverAuthGuard implements CanActivate {
  constructor(private jwt: JwtService, @Inject(DB_TOKEN) private db: Kysely<DB>) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const id = await readToken(this.jwt, req, 'driver');
    const d = await this.db.selectFrom('drivers').selectAll().where('id', '=', id).executeTakeFirst();
    if (!d) throw notSignedIn();
    req.driver = d;
    return true;
  }
}
