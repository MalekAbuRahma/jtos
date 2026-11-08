import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { CasesService } from '../cases/cases.service';
import { DriverAuthGuard, PassengerAuthGuard } from '../common/person-auth.guard';
import { Require, StaffAuthGuard } from '../common/staff-auth.guard';
import { CorrectionsService } from './corrections.service';
import { PassengerTripDayService } from './passenger-tripday.service';
import { TripDayService } from './tripday.service';

const meta = (b: any, key?: string) => ({ actionId: key ?? b?.actionId, at: b?.at, lat: b?.lat, lng: b?.lng });

@Controller('v1/driver')
@UseGuards(DriverAuthGuard)
export class DriverTripDayController {
  constructor(private s: TripDayService, private p: PassengerTripDayService, private cases: CasesService) {}
  @Get('trips/:id/board') board(@Req() r: any, @Param('id') id: string) { return this.s.board(r.driver, id); }
  @Post('trips/:id/stops/:seq/arrived') @HttpCode(200)
  arrived(@Req() r: any, @Param('id') id: string, @Param('seq') seq: string, @Body() b: any, @Headers('idempotency-key') k?: string) { return this.s.arrived(r.driver, id, Number(seq), meta(b, k)); }
  @Post('trips/:id/stops/:seq/leave') @HttpCode(200)
  leave(@Req() r: any, @Param('id') id: string, @Param('seq') seq: string, @Body() b: any, @Headers('idempotency-key') k?: string) { return this.s.leave(r.driver, id, Number(seq), meta(b, k)); }
  @Post('trips/:id/complete') @HttpCode(200)
  complete(@Req() r: any, @Param('id') id: string, @Body() b: any, @Headers('idempotency-key') k?: string) { return this.s.complete(r.driver, id, meta(b, k)); }
  @Post('travellers/:id/boarded') @HttpCode(200)
  boarded(@Req() r: any, @Param('id') id: string, @Body() b: any, @Headers('idempotency-key') k?: string) { return this.s.boarded(r.driver, id, meta(b, k)); }
  @Post('travellers/:id/no-show') @HttpCode(200)
  noShow(@Req() r: any, @Param('id') id: string, @Body() b: any, @Headers('idempotency-key') k?: string) { return this.s.noShow(r.driver, id, meta(b, k)); }
  @Post('bookings/:id/contact-attempt') @HttpCode(200)
  contact(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.s.contactAttempt(r.driver, id, b?.kind); }
  @Post('bookings/:id/cash') @HttpCode(200)
  cash(@Req() r: any, @Param('id') id: string, @Body() b: any, @Headers('idempotency-key') k?: string) { return this.s.cash(r.driver, id, b ?? {}, meta(b, k)); }
  @Post('bookings/:id/cash-case') @HttpCode(200)
  cashCase(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.p.cashCase({ type: 'driver', id: r.driver.id }, id, b?.reason, b?.statement); }
  @Post('sync') @HttpCode(200) sync(@Req() r: any, @Body() b: any) { return this.s.sync(r.driver, b?.actions); }
  @Get('cases') myCases(@Req() r: any) { return this.cases.mine({ type: 'driver', id: r.driver.id }); }
  @Post('cases/:id/statement') @HttpCode(200) statement(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.cases.addStatement(id, { type: 'driver', id: r.driver.id }, b?.text); }
}

@Controller('v1/passenger')
@UseGuards(PassengerAuthGuard)
export class PassengerTripDayController {
  constructor(private p: PassengerTripDayService, private cases: CasesService) {}
  @Get('bookings/:id/cancel-preview') preview(@Req() r: any, @Param('id') id: string) { return this.p.cancelPreview(r.passenger.id, id); }
  @Post('bookings/:id/cancel') @HttpCode(200) cancel(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.p.cancel(r.passenger.id, id, b?.reason); }
  @Post('bookings/:id/dispute-no-show') @HttpCode(200) dispute(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.p.disputeNoShow(r.passenger.id, id, b?.statement); }
  @Post('bookings/:id/cash-case') @HttpCode(200) cashCase(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.p.cashCase({ type: 'passenger', id: r.passenger.id }, id, b?.reason, b?.statement); }
  @Get('cases') myCases(@Req() r: any) { return this.cases.mine({ type: 'passenger', id: r.passenger.id }); }
  @Post('cases/:id/statement') @HttpCode(200) statement(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.cases.addStatement(id, { type: 'passenger', id: r.passenger.id }, b?.text); }
}

@Controller('v1/staff')
@UseGuards(StaffAuthGuard)
export class StaffCasesController {
  constructor(private cases: CasesService, private corr: CorrectionsService, private p: PassengerTripDayService) {}
  @Get('cases') @Require('bookings.view') list(@Query('status') status?: string) { return this.cases.list(status); }
  @Get('cases/:id') @Require('bookings.view') one(@Param('id') id: string) { return this.cases.detail(id); }
  @Post('cases/:id/ask') @HttpCode(200) @Require('cases.handle') ask(@Req() r: any, @Param('id') id: string) { return this.cases.askReply(r.staff, id); }
  @Post('cases/:id/resolve') @HttpCode(200) @Require('cases.handle') resolve(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.cases.resolve(r.staff, id, b?.note, b?.warn); }
  @Post('corrections/service') @HttpCode(200) @Require('records.correct')
  service(@Req() r: any, @Body() b: any) { return this.corr.service(r.staff, b?.travellerId, b?.status, b?.reason, r.ip); }
  @Post('corrections/requests') @HttpCode(200) @Require('records.request_correction')
  request(@Req() r: any, @Body() b: any) { return this.corr.request(r.staff, b?.travellerId, b?.status, b?.reason); }
  @Post('corrections/cash') @HttpCode(200) @Require('cash.correct')
  cash(@Req() r: any, @Body() b: any, @Headers('idempotency-key') k?: string) { return this.corr.cash(r.staff, b?.cashRecordId, b?.received, b?.reason, k, r.ip); }
  @Get('bookings/:id/cash') @Require('bookings.view') cashHistory(@Param('id') id: string) { return this.corr.cashHistory(id); }
  @Get('reports/late-drivers') @Require('reports.view') late() { return this.p.lateReport(); }
}
