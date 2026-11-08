import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { PassengerAuthGuard } from '../common/person-auth.guard';
import { PassengerAuthService } from './passenger-auth.service';

@Controller('v1/passenger/auth')
export class PassengerAuthController {
  constructor(private s: PassengerAuthService) {}
  @Post('code') @HttpCode(200) code(@Body() b: any) { return this.s.sendLoginCode(b?.phone, b?.channel); }
  @Post('verify') @HttpCode(200) verify(@Body() b: any) { return this.s.verifyLogin(b?.ticket, b?.code); }
  @Post('signup') @HttpCode(200) signup(@Body() b: any) { return this.s.startSignup(b?.signupToken, b?.fullName, b?.email); }
  @Post('signup/verify-email') @HttpCode(200) finish(@Body() b: any) { return this.s.finishSignup(b?.emailTicket, b?.code); }
  @Post('recover') @HttpCode(200) recover(@Body() b: any) { return this.s.sendRecoveryCode(b?.email); }
  @Post('recover/verify') @HttpCode(200) recoverVerify(@Body() b: any) { return this.s.verifyRecovery(b?.ticket, b?.code); }
}

@Controller('v1/passenger/me')
@UseGuards(PassengerAuthGuard)
export class PassengerMeController {
  constructor(private s: PassengerAuthService) {}
  @Get() me(@Req() req: any) {
    const p = req.passenger;
    return { id: p.id, fullName: p.full_name, phone: p.phone, email: p.email, status: p.status };
  }
  @Post('phone') @HttpCode(200) phone(@Req() req: any, @Body() b: any) { return this.s.sendChangePhoneCode(req.passenger.id, b?.phone); }
  @Post('phone/verify') @HttpCode(200) phoneVerify(@Req() req: any, @Body() b: any) { return this.s.verifyChangePhone(req.passenger.id, b?.ticket, b?.code); }
}
