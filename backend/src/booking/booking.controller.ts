import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { DriverAuthGuard, PassengerAuthGuard } from '../common/person-auth.guard';
import { RateLimit, RateLimitGuard } from '../common/rate-limit.guard';
import { BookingViewService } from './booking-view.service';
import { BookingService } from './booking.service';

@Controller('v1/passenger')
@UseGuards(PassengerAuthGuard, RateLimitGuard)
export class PassengerBookingController {
  constructor(private s: BookingService, private v: BookingViewService) {}
  @Post('requests') @RateLimit(20)
  create(@Req() r: any, @Body() b: any, @Headers('idempotency-key') key?: string) { return this.s.createRequest(r.passenger, b, key); }
  @Get('requests') list(@Req() r: any) { return this.s.listPassengerRequests(r.passenger.id); }
  @Get('requests/:id') one(@Req() r: any, @Param('id') id: string) { return this.s.passengerRequestView(r.passenger.id, id); }
  @Post('requests/:id/withdraw') @HttpCode(200) withdraw(@Req() r: any, @Param('id') id: string) { return this.s.withdraw(r.passenger.id, id); }
  @Get('bookings') bookings(@Req() r: any) { return this.v.list(r.passenger.id); }
  @Get('bookings/:id') booking(@Req() r: any, @Param('id') id: string) { return this.v.view(r.passenger.id, id); }
  @Post('bookings/:id/complete') @HttpCode(200) complete(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.s.complete(r.passenger.id, id, b?.paymentMethod); }
}

@Controller('v1/driver/requests')
@UseGuards(DriverAuthGuard)
export class DriverRequestsController {
  constructor(private s: BookingService) {}
  @Get() list(@Req() r: any, @Query('status') status?: string) { return this.s.driverRequests(r.driver, status || 'waiting'); }
  @Get(':id') one(@Req() r: any, @Param('id') id: string) { return this.s.driverRequestView(r.driver, id); }
  @Post(':id/accept') @HttpCode(200) accept(@Req() r: any, @Param('id') id: string) { return this.s.accept(r.driver, id); }
  @Post(':id/reject') @HttpCode(200) reject(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.s.reject(r.driver, id, b?.reason, b?.note); }
}
