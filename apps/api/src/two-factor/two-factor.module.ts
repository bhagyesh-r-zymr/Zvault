import { Module, type DynamicModule, type ModuleMetadata, type Type } from '@nestjs/common';
import {
  AUTHENTICATED_USER_RESOLVER,
  AuthenticatedUserGuard,
  NoSessionResolver,
  type AuthenticatedUserResolver,
} from './authenticated-user.js';
import { systemClock, TWO_FACTOR_CLOCK } from './clock.js';
import { loadTwoFactorConfig, TWO_FACTOR_CONFIG } from './two-factor.config.js';
import { TwoFactorController } from './two-factor.controller.js';
import {
  InMemoryTwoFactorRepository,
  TWO_FACTOR_REPOSITORY,
  type TwoFactorRepository,
} from './two-factor.repository.js';
import { TwoFactorService } from './two-factor.service.js';

export interface TwoFactorModuleOptions {
  /** Modules that provide the classes below (e.g. the database and session modules). */
  imports?: ModuleMetadata['imports'];
  repository?: Type<TwoFactorRepository>;
  userResolver?: Type<AuthenticatedUserResolver>;
}

/**
 * TOTP second factor. Defaults to an in-memory store and no sessions; the
 * app passes the database repository and session resolver. Global, so login
 * can reach `TwoFactorService` without a second instance.
 */
@Module({})
export class TwoFactorModule {
  static forRoot(options: TwoFactorModuleOptions = {}): DynamicModule {
    return {
      global: true,
      module: TwoFactorModule,
      imports: options.imports ?? [],
      controllers: [TwoFactorController],
      providers: [
        TwoFactorService,
        AuthenticatedUserGuard,
        { provide: TWO_FACTOR_CONFIG, useFactory: () => loadTwoFactorConfig() },
        { provide: TWO_FACTOR_CLOCK, useValue: systemClock },
        {
          provide: TWO_FACTOR_REPOSITORY,
          useClass: options.repository ?? InMemoryTwoFactorRepository,
        },
        {
          provide: AUTHENTICATED_USER_RESOLVER,
          useClass: options.userResolver ?? NoSessionResolver,
        },
      ],
      exports: [TwoFactorService],
    };
  }
}
