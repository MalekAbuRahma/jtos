import { Controller, Get, Inject } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { DB_TOKEN } from './common/tokens';
import { DB } from './db/database';

@Controller()
export class HealthController {
  constructor(@Inject(DB_TOKEN) private db: Kysely<DB>) {}
  @Get('health')
  async health() {
    await sql`select 1`.execute(this.db);
    return { status: 'ok', service: 'jtos-api', stage: process.env.STAGE ?? 'local' };
  }
}
