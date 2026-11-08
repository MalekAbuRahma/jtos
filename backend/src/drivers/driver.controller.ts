import { Body, Controller, Get, HttpCode, Post, Put, Query, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { isDate, jordanDate } from '../common/dates';
import { badInput } from '../common/errors';
import { DriverAuthGuard } from '../common/person-auth.guard';
import { DriverService } from './driver.service';
import { EligibilityService } from './eligibility.service';

@Controller('v1/driver/auth')
export class DriverAuthController {
  constructor(private s: DriverService) {}
  @Post('code') @HttpCode(200) code(@Body() b: any) { return this.s.sendCode(b?.phone, b?.channel); }
  @Post('verify') @HttpCode(200) verify(@Body() b: any) { return this.s.verifyCode(b?.ticket, b?.code); }
}

@Controller('v1/driver/me')
@UseGuards(DriverAuthGuard)
export class DriverMeController {
  constructor(private s: DriverService, private elig: EligibilityService) {}

  @Get() me(@Req() req: any) { return this.s.me(req.driver); }
  @Put('profile') profile(@Req() req: any, @Body() b: any) { return this.s.updateProfile(req.driver, b?.fullName, b?.email); }
  @Put('vehicle') vehicle(@Req() req: any, @Body() b: any) { return this.s.saveVehicle(req.driver, b ?? {}); }

  @Post('documents')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 6 * 1024 * 1024 } }))
  upload(@Req() req: any, @UploadedFile() file: any, @Body() b: any) {
    return this.s.uploadDocument(req.driver, b?.type, b?.expiresAt, file);
  }

  @Post('application/submit') @HttpCode(200) submit(@Req() req: any) { return this.s.submit(req.driver); }

  /** Used before publishing a trip (T-004). */
  @Get('eligibility')
  eligibility(@Req() req: any, @Query('date') date?: string) {
    const d = date ?? jordanDate();
    if (!isDate(d)) throw badInput('BAD_DATE', 'Use the date format YYYY-MM-DD.');
    return this.elig.check(req.driver.id, d);
  }
}
