import { DynamicModule, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { Kysely } from 'kysely';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './common/audit.service';
import { EmailService } from './common/email.service';
import { StaffAuthGuard } from './common/staff-auth.guard';
import { CONFIG_TOKEN, DB_TOKEN } from './common/tokens';
import { AppConfig } from './config';
import { DB } from './db/database';
import { HealthController } from './health.controller';
import { SettingsController } from './settings/settings.controller';
import { SettingsService } from './settings/settings.service';
import { StaffAuthService } from './staff/staff-auth.service';
import { StaffAuthController, StaffController } from './staff/staff.controller';
import { StaffService } from './staff/staff.service';

@Module({})
export class AppModule {
  static create(cfg: AppConfig, db: Kysely<DB>): DynamicModule {
    return {
      module: AppModule,
      imports: [JwtModule.register({ secret: cfg.jwtSecret })],
      controllers: [HealthController, StaffAuthController, StaffController, SettingsController, AuditController],
      providers: [
        { provide: CONFIG_TOKEN, useValue: cfg },
        { provide: DB_TOKEN, useValue: db },
        AuditService, EmailService, SettingsService, StaffAuthService, StaffService, StaffAuthGuard,
      ],
    };
  }
}
