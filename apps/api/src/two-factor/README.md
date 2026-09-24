# Two-factor authentication (TOTP)

RFC 6238 TOTP (SHA1, 6 digits, 30 s, ±1 step) plus ten single-use recovery codes.

## Endpoints (signed-in user)

| Method | Path                     | Body                             | Result                    |
| ------ | ------------------------ | -------------------------------- | ------------------------- |
| GET    | `/v1/2fa`                | none                             | `TwoFactorStatusResponse` |
| POST   | `/v1/2fa/totp/setup`     | none                             | `TotpSetupResponse`       |
| POST   | `/v1/2fa/totp/confirm`   | `{ code }`                       | `RecoveryCodesResponse`   |
| POST   | `/v1/2fa/recovery-codes` | `{ code }` or `{ recoveryCode }` | `RecoveryCodesResponse`   |
| POST   | `/v1/2fa/disable`        | `{ code }` or `{ recoveryCode }` | 204                       |

A wrong code returns 403 `invalid_two_factor_code`. Five wrong codes lock the factor for 15
minutes and return 429 `two_factor_locked`.

## Hooking into login

The login feature owns sessions and storage. It plugs in with:

```ts
TwoFactorModule.forRoot({
  imports: [DatabaseModule, SessionModule],
  repository: DbTwoFactorRepository, // implements TwoFactorRepository
  userResolver: SessionUserResolver, // implements AuthenticatedUserResolver
});
```

After the first factor (SRP) succeeds, login calls `TwoFactorService.isEnabled(userId)`. If it is
on, login issues a short-lived "2FA pending" state instead of a full session, and completes only
once `TwoFactorService.verify(userId, proof)` resolves. `verify` consumes the proof (a TOTP code
cannot be replayed, a recovery code is deleted) and throws on failure.

`TwoFactorRepository.update` must be a compare-and-set on `version` (for example
`UPDATE ... WHERE user_id = $1 AND version = $2`) so concurrent requests cannot spend one code twice.

## Storage and keys

TOTP is checked by the server, so the server has to know the secret. It is sealed with
AES-256-GCM, bound to the user id, under a key derived from `TWO_FACTOR_ENCRYPTION_KEY`. Recovery
codes are kept only as HMAC-SHA256 hashes. In AWS the key comes from Secrets Manager, and the API
refuses to start in production without it. None of this touches vault keys, which never leave the
device.
