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

## Login

`AppModule` wires this module to Postgres (`DrizzleTwoFactorRepository`, table `two_factor`) and
to sessions (`SessionUserResolver` in `auth/`), so the endpoints above take the normal
`Authorization: Bearer <session token>`.

When 2FA is on, `POST /v1/auth/login/finish` does not open a session. It returns
`{ srpM2, twoFactorRequired: true, twoFactorToken, expiresAt }` and keeps the login pending for
five minutes. The client checks `srpM2` first, then sends
`POST /v1/auth/login/two-factor { twoFactorToken, proof }`, where `proof` is `{ code }` or
`{ recoveryCode }`. Only that response carries the session token and the encrypted keyset. A
pending login allows five codes; wrong codes also count toward the account lockout above.

`TwoFactorRepository.update` must be a compare-and-set on `version` (for example
`UPDATE ... WHERE user_id = $1 AND version = $2`) so concurrent requests cannot spend one code twice.

## Storage and keys

TOTP is checked by the server, so the server has to know the secret. It is sealed with
AES-256-GCM, bound to the user id, under a key derived from `TWO_FACTOR_ENCRYPTION_KEY`. Recovery
codes are kept only as HMAC-SHA256 hashes. In AWS the key comes from Secrets Manager, and the API
refuses to start in production without it. None of this touches vault keys, which never leave the
device.
