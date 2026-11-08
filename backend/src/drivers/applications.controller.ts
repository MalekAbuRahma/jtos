import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Require, StaffAuthGuard } from '../common/staff-auth.guard';
import { ApplicationsService } from './applications.service';

@Controller('v1/staff')
@UseGuards(StaffAuthGuard)
export class ApplicationsController {
  constructor(private s: ApplicationsService) {}

  @Get('applications') @Require('drivers.view')
  queue(@Query('status') status?: string) { return this.s.queue(status || 'submitted'); }

  @Get('applications/:id') @Require('drivers.view')
  detail(@Param('id', ParseUUIDPipe) id: string) { return this.s.detail(id); }

  @Post('applications/:id/decision') @HttpCode(200) @Require('drivers.review')
  decide(@Req() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() b: any) {
    return this.s.decide(req.staff, id, b?.decision, b?.note, b?.documentNotes, req.ip);
  }

  @Get('documents/:id/file') @Require('documents.view')
  async file(@Req() req: any, @Param('id', ParseUUIDPipe) id: string, @Res() res: any) {
    const f = await this.s.documentFile(req.staff, id, req.ip);
    res.set({ 'Content-Type': f.mime, 'Cache-Control': 'no-store', 'Content-Disposition': 'inline' }).send(f.data);
  }
}
