import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryTwoFactorRepository } from './two-factor.repository.js';
import { TwoFactorService } from './two-factor.service.js';
import { base32Decode, hotp, timeStep } from './totp.js';

function setup() {
  const clock = { t: 1_800_000_000_000, now: () => clock.t };
  const repo = new InMemoryTwoFactorRepository();
  const service = new TwoFactorService(
    repo,
    { masterKey: randomBytes(32), issuer: 'Zvault' },
    clock,
  );
  return { clock, repo, service };
}

describe('TwoFactorService', () => {
  it('spends a code only once when two requests race', async () => {
    const { clock, service } = setup();
    const { secret } = await service.beginSetup('u', 'u@example.com');
    const raw = base32Decode(secret);
    await service.confirmSetup('u', hotp(raw, timeStep(clock.t)));
    clock.t += 30_000;
    const code = hotp(raw, timeStep(clock.t));
    const results = await Promise.allSettled([
      service.verify('u', { code }),
      service.verify('u', { code }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('stores neither the TOTP secret nor recovery codes in the clear', async () => {
    const { clock, repo, service } = setup();
    const { secret } = await service.beginSetup('u', 'u@example.com');
    const raw = base32Decode(secret);
    const { recoveryCodes } = await service.confirmSetup('u', hotp(raw, timeStep(clock.t)));
    const stored = JSON.stringify(await repo.find('u'));
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain(raw.toString('base64url'));
    for (const c of recoveryCodes) expect(stored).not.toContain(c);
  });
});
