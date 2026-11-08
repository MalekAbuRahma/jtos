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
import { DriverExtrasController, PassengerExtrasController, PublicShareController } from './extras/extras.controller';
import { ExtrasService } from './extras/extras.service';
import { CasesService } from './cases/cases.service';
import { CorrectionsService } from './tripday/corrections.service';
import { PassengerTripDayService } from './tripday/passenger-tripday.service';
import { DriverTripDayController, PassengerTripDayController, StaffCasesController } from './tripday/tripday.controller';
import { TripDayService } from './tripday/tripday.service';
import { DriverRequestsController, PassengerBookingController } from './booking/booking.controller';
import { BookingViewService } from './booking/booking-view.service';
import { BookingService } from './booking/booking.service';
import { RateLimitGuard } from './common/rate-limit.guard';
import { CatalogService } from './trips/catalog.service';
import { SearchService } from './trips/search.service';
import { DriverTripsController, PublicController, StaffTripsController } from './trips/trips.controller';
import { TripsService } from './trips/trips.service';
import { MessagingService } from './common/messaging.service';
import { OtpService } from './common/otp.service';
import { DriverAuthGuard, PassengerAuthGuard } from './common/person-auth.guard';
import { ApplicationsController } from './drivers/applications.controller';
import { ApplicationsService } from './drivers/applications.service';
import { DriverAuthController, DriverMeController } from './drivers/driver.controller';
import { DriverService } from './drivers/driver.service';
import { EligibilityService } from './drivers/eligibility.service';
import { ExpiryJobService } from './drivers/expiry-job.service';
import { PassengerAuthController, PassengerMeController } from './passengers/passenger.controller';
import { PassengerAuthService } from './passengers/passenger-auth.service';
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
      controllers: [HealthController, StaffAuthController, StaffController, SettingsController, AuditController,
        PassengerAuthController, PassengerMeController, DriverAuthController, DriverMeController, ApplicationsController,
        DriverTripsController, PublicController, StaffTripsController,
        PassengerBookingController, DriverRequestsController,
        DriverTripDayController, PassengerTripDayController, StaffCasesController,
        PassengerExtrasController, DriverExtrasController, PublicShareController],
      providers: [
        { provide: CONFIG_TOKEN, useValue: cfg },
        { provide: DB_TOKEN, useValue: db },
        AuditService, EmailService, SettingsService, StaffAuthService, StaffService, StaffAuthGuard,
        MessagingService, OtpService, PassengerAuthGuard, DriverAuthGuard, PassengerAuthService,
        DriverService, EligibilityService, ExpiryJobService, ApplicationsService,
        RateLimitGuard, CatalogService, SearchService, TripsService,
        BookingService, BookingViewService,
        CasesService, CorrectionsService, PassengerTripDayService, TripDayService,
        ExtrasService,
      ],
    };
  }
}
