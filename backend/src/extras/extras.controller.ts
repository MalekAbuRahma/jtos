import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { DriverAuthGuard, PassengerAuthGuard } from '../common/person-auth.guard';
import { RateLimit, RateLimitGuard } from '../common/rate-limit.guard';
import { ExtrasService } from './extras.service';

@Controller('v1/passenger')
@UseGuards(PassengerAuthGuard, RateLimitGuard)
export class PassengerExtrasController {
  constructor(private s: ExtrasService) {}
  @Post('bookings/:id/rating') @HttpCode(200) rate(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.s.rate({ type: 'passenger', id: r.passenger.id }, id, b?.stars, b?.comment); }
  @Get('bookings/:id/messages') msgs(@Req() r: any, @Param('id') id: string) { return this.s.messages({ type: 'passenger', id: r.passenger.id }, id); }
  @Post('bookings/:id/messages') @RateLimit(30) send(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.s.send({ type: 'passenger', id: r.passenger.id }, id, b?.text); }
  @Post('bookings/:id/share-link') share(@Req() r: any, @Param('id') id: string) { return this.s.shareLink(r.passenger.id, id); }
  @Post('requests/:id/travellers/:idx/remove') @HttpCode(200) remove(@Req() r: any, @Param('id') id: string, @Param('idx') idx: string) { return this.s.removeTraveller(r.passenger.id, id, Number(idx)); }
}

@Controller('v1/driver')
@UseGuards(DriverAuthGuard, RateLimitGuard)
export class DriverExtrasController {
  constructor(private s: ExtrasService) {}
  @Post('bookings/:id/rating') @HttpCode(200) rate(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.s.rate({ type: 'driver', id: r.driver.id }, id, b?.stars, b?.comment); }
  @Get('bookings/:id/messages') msgs(@Req() r: any, @Param('id') id: string) { return this.s.messages({ type: 'driver', id: r.driver.id }, id); }
  @Post('bookings/:id/messages') @RateLimit(30) send(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.s.send({ type: 'driver', id: r.driver.id }, id, b?.text); }
  @Post('trips/:id/position') @HttpCode(200) @RateLimit(120) pos(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.s.position(r.driver.id, id, b?.lat, b?.lng); }
  @Get('earnings') earnings(@Req() r: any, @Query('period') p?: string) { return this.s.earnings(r.driver.id, p); }
}

@Controller('v1/public')
@UseGuards(RateLimitGuard)
export class PublicShareController {
  constructor(private s: ExtrasService) {}
  @Get('share/:token') @RateLimit(120) share(@Param('token') token: string) { return this.s.sharedTrip(token); }
}
