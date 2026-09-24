import { Controller, Get } from '@nestjs/common';
import {
  CRYPTO_VERSION,
  KDF_DEFAULTS,
  KDF_MINIMUMS,
  type CryptoMetaResponse,
} from '@zvault/shared';

/** Tells clients which crypto parameters this server accepts. Public, non-secret. */
@Controller('meta')
export class MetaController {
  @Get('crypto')
  crypto(): CryptoMetaResponse {
    return {
      cryptoVersion: CRYPTO_VERSION,
      kdfMinimums: KDF_MINIMUMS,
      kdfDefaults: KDF_DEFAULTS,
      aead: 'xchacha20poly1305',
    };
  }
}
