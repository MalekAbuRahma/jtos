import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ROLE_PERMISSIONS } from '../common/permissions';
import { Require, StaffAuthGuard } from '../common/staff-auth.guard';
import { StaffAuthService } from './staff-auth.service';
import { StaffService } from './staff.service';

@Controller('v1/staff/auth')
export class StaffAuthController {
  constructor(private auth: StaffAuthService) {}

  @Post('login') @HttpCode(200)
  login(@Req() req: any, @Body() b: { email: string; password: string }) {
    return this.auth.login(b?.email, b?.password, req.ip);
  }

  @Post('verify') @HttpCode(200)
  verify(@Req() req: any, @Body() b: { loginTicket: string; code: string }) {
    return this.auth.verify(b?.loginTicket, b?.code, req.ip);
  }

  @Post('set-password') @HttpCode(200)
  async setPassword(@Body() b: { token: string; password: string }) {
    await this.auth.setPassword(b?.token, b?.password);
    return { ok: true };
  }
}

@Controller('v1/staff')
@UseGuards(StaffAuthGuard)
export class StaffController {
  constructor(private staff: StaffService) {}

  @Get('me')
  me(@Req() req: any) {
    const s = req.staff;
    return { ...s, permissions: s.role ? ROLE_PERMISSIONS[s.role as keyof typeof ROLE_PERMISSIONS] : [] };
  }

  @Get('roles') @Require('roles.view')
  roles() { return ROLE_PERMISSIONS; }

  @Get('staff') @Require('staff.view')
  list() { return this.staff.list(); }

  @Post('staff') @Require('staff.manage')
  create(@Req() req: any, @Body() b: { fullName: string; email: string }) {
    return this.staff.create(req.staff, b?.fullName, b?.email, req.ip);
  }

  @Post('staff/:id/role') @HttpCode(200) @Require('staff.manage')
  role(@Req() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() b: { role: 'admin' | 'support' | 'auditor' | null }) {
    return this.staff.setRole(req.staff, id, b?.role ?? null, req.ip);
  }

  @Post('staff/:id/deactivate') @HttpCode(200) @Require('staff.manage')
  deactivate(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.staff.deactivate(req.staff, id, req.ip);
  }

  @Post('staff/:id/resend-invitation') @HttpCode(200) @Require('staff.manage')
  resend(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.staff.resendInvitation(req.staff, id);
  }
}
