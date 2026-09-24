import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';
import { ENV } from './config/config.module.js';
import type { Env } from './config/env.js';

async function main(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  const env = app.get<Env>(ENV);
  // Request bodies carry ciphertext only; cap them to limit abuse.
  app.useBodyParser('json', { limit: '1mb' });
  if (env.TRUST_PROXY_HOPS > 0) app.set('trust proxy', env.TRUST_PROXY_HOPS);
  configureApp(app, env);
  await app.listen(env.PORT);
}

void main();
