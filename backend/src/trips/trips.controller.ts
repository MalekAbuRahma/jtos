import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { isDate } from '../common/dates';
import { badInput, conflict, notFound } from '../common/errors';
import { DriverAuthGuard } from '../common/person-auth.guard';
import { RateLimit, RateLimitGuard } from '../common/rate-limit.guard';
import { Require, StaffAuthGuard } from '../common/staff-auth.guard';
import { Inject } from '@nestjs/common';
import { Kysely } from 'kysely';
import { DB_TOKEN } from '../common/tokens';
import { DB } from '../db/database';
import { CatalogService } from './catalog.service';
import { SearchService } from './search.service';
import { TripsService } from './trips.service';

@Controller('v1/driver/trips')
@UseGuards(DriverAuthGuard)
export class DriverTripsController {
  constructor(private s: TripsService) {}
  @Get() list(@Req() r: any) { return this.s.list(r.driver); }
  @Post() create(@Req() r: any, @Body() b: any) { return this.s.create(r.driver, b); }
  @Get(':id') view(@Req() r: any, @Param('id') id: string) { return this.s.view(r.driver, id); }
  @Put(':id') update(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.s.update(r.driver, id, b); }
  @Post(':id/publish') @HttpCode(200) publish(@Req() r: any, @Param('id') id: string, @Headers('idempotency-key') key?: string) { return this.s.publish(r.driver, id, key); }
  @Post(':id/last-chance') @HttpCode(200) lastChance(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.s.lastChance(r.driver, id, b?.prices); }
  @Post(':id/cancel') @HttpCode(200) cancel(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.s.cancel(r.driver, id, b?.reason); }
  @Post(':id/repeat') repeat(@Req() r: any, @Param('id') id: string, @Body() b: any) {
    if (!isDate(b?.date)) throw badInput('BAD_DATE', 'Choose the new date.');
    return this.s.repeat(r.driver, id, b.date);
  }
}

@Controller('v1/public')
@UseGuards(RateLimitGuard)
export class PublicController {
  constructor(private search: SearchService, private catalog: CatalogService) {}
  @Get('cities') @RateLimit(60) cities() { return this.catalog.cities(); }
  @Get('search') @RateLimit(60) find(@Query() q: any) { return this.search.search(q); }
  @Get('trips/:id') @RateLimit(120) trip(@Param('id') id: string, @Query('from') from?: string) { return this.search.trip(id, from); }
  @Get('drivers/:id/photo') @RateLimit(240)
  async photo(@Param('id') id: string, @Res() res: any) {
    const p = await this.search.driverPhoto(id);
    res.set({ 'Content-Type': p.mime, 'Cache-Control': 'private, max-age=300' }).send(p.data);
  }
}

@Controller('v1/staff')
@UseGuards(StaffAuthGuard)
export class StaffTripsController {
  constructor(private catalog: CatalogService, private audit: AuditService, @Inject(DB_TOKEN) private db: Kysely<DB>) {}

  @Get('price-ranges') @Require('settings.view') ranges() { return this.catalog.listRanges(); }
  @Put('price-ranges') @Require('settings.edit') save(@Req() r: any, @Body() b: any) { return this.catalog.saveRange(r.staff.id, b, r.ip); }

  @Get('trips') @Require('bookings.view')
  trips(@Query('date') date?: string) {
    let q = this.db.selectFrom('trips as t').innerJoin('drivers as d', 'd.id', 't.driver_id')
      .select(['t.id', 't.status', 't.travel_date as date', 't.seats_offered as seatsOffered', 't.seats_booked as seatsBooked', 't.seats_held as seatsHeld', 'd.full_name as driverName', 't.suspended_reason as suspendedReason'])
      .orderBy('t.travel_date', 'desc').limit(200);
    if (date) q = q.where('t.travel_date', '=', date);
    return q.execute();
  }

  @Post('trips/:id/suspend') @HttpCode(200) @Require('trips.suspend')
  async suspend(@Req() r: any, @Param('id', ParseUUIDPipe) id: string, @Body() b: any) {
    const reason = typeof b?.reason === 'string' ? b.reason.trim() : '';
    if (!reason) throw badInput('REASON_REQUIRED', 'Write the reason for suspending this trip.');
    const t = await this.db.selectFrom('trips').select(['status']).where('id', '=', id).executeTakeFirst();
    if (!t) throw notFound('Trip');
    if (t.status !== 'published') throw conflict('NOT_PUBLISHED', 'Only a published trip can be suspended.');
    await this.db.updateTable('trips').set({ status: 'suspended', suspended_reason: reason, updated_at: new Date() }).where('id', '=', id).execute();
    await this.audit.record({ actorType: 'staff', actorId: r.staff.id, action: 'trip.suspended', recordType: 'trip', recordId: id, after: { reason }, ip: r.ip });
    return { id, status: 'suspended' };
  }

  @Post('trips/:id/unsuspend') @HttpCode(200) @Require('trips.suspend')
  async unsuspend(@Req() r: any, @Param('id', ParseUUIDPipe) id: string) {
    const t = await this.db.selectFrom('trips').select(['status']).where('id', '=', id).executeTakeFirst();
    if (!t) throw notFound('Trip');
    if (t.status !== 'suspended') throw conflict('NOT_SUSPENDED', 'This trip is not suspended.');
    await this.db.updateTable('trips').set({ status: 'published', suspended_reason: null, updated_at: new Date() }).where('id', '=', id).execute();
    await this.audit.record({ actorType: 'staff', actorId: r.staff.id, action: 'trip.unsuspended', recordType: 'trip', recordId: id, ip: r.ip });
    return { id, status: 'published' };
  }
}
