import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ExpiryJobService } from './drivers/expiry-job.service';
import { BookingService } from './booking/booking.service';
import { loadConfig } from './config';
import { createDb } from './db/database';
import { migrate } from './db/migrate';

async function bootstrap() {
  const cfg = loadConfig();
  await migrate(cfg.databaseUrl);
  const app = await NestFactory.create(AppModule.create(cfg, createDb(cfg.databaseUrl)));
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  // Daily-style job: document expiry warnings (checked every 6 hours; each document is warned once).
  const expiry = app.get(ExpiryJobService);
  const runExpiry = () => expiry.run().catch((e) => console.error('expiry job failed', e));
  setTimeout(runExpiry, 60_000);
  setInterval(runExpiry, 6 * 3600_000);
  // Booking jobs: expire requests at their deadline (every minute); WhatsApp backup to drivers (every 5 min).
  const booking = app.get(BookingService);
  setInterval(() => booking.expireDue().catch((e) => console.error('expire job failed', e)), 60_000);
  setInterval(() => booking.whatsappBackups().catch((e) => console.error('whatsapp job failed', e)), 5 * 60_000);
  console.log(`JTOS API listening on ${port}`);
}
bootstrap();
