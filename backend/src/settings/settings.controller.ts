import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { Require, StaffAuthGuard } from '../common/staff-auth.guard';
import { SETTINGS } from './definitions';
import { SettingsService } from './settings.service';

@Controller('v1/staff/settings')
@UseGuards(StaffAuthGuard)
export class SettingsController {
  constructor(private settings: SettingsService) {}

  @Get()
  @Require('settings.view')
  async get() {
    const current = await this.settings.versionAt();
    return {
      version: current.version,
      values: current.values,
      definitions: SETTINGS,
      scheduled: await this.settings.scheduled(),
      lastChange: await this.settings.lastChange(),
      note: 'Changes apply to new requests only. Requests already sent keep the values they were sent with.',
    };
  }

  @Put()
  @Require('settings.edit')
  async put(@Req() req: any, @Body() body: { changes: Record<string, unknown>; effectiveFrom?: string }) {
    const v = await this.settings.change(req.staff.id, body?.changes ?? {}, body?.effectiveFrom, req.ip);
    return { version: v.version, values: v.values, effectiveFrom: v.effectiveFrom };
  }
}
