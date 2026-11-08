import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
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
  console.log(`JTOS API listening on ${port}`);
}
bootstrap();
