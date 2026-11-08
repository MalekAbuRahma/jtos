import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ExpiryJobService } from './drivers/expiry-job.service';
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
  console.log(`JTOS API listening on ${port}`);
}
bootstrap();
