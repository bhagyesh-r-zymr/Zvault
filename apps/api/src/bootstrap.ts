import type { INestApplication } from '@nestjs/common';
import { VersioningType } from '@nestjs/common';
import helmet from 'helmet';
import type { Env } from './config/env.js';

/** Applies the security baseline shared by the server and the e2e tests. */
export function configureApp(app: INestApplication, env: Env): INestApplication {
  app.use(helmet());
  app.enableCors({
    origin: env.CORS_ORIGINS,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.enableShutdownHooks();
  return app;
}
