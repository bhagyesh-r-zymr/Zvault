import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { describe, expect, it, vi } from 'vitest';
import { secretsManagerPassword } from './pool.js';

function client(...passwords: string[]) {
  const send = vi.fn();
  for (const password of passwords) {
    send.mockResolvedValueOnce({ SecretString: JSON.stringify({ username: 'u', password }) });
  }
  return { send } as unknown as Pick<SecretsManagerClient, 'send'> & { send: typeof send };
}

describe('secretsManagerPassword', () => {
  it('caches briefly, then picks up a rotated password', async () => {
    let t = 0;
    const sm = client('first', 'rotated');
    const password = secretsManagerPassword('arn:secret', sm, () => t);
    expect(await password()).toBe('first');
    t = 29_000;
    expect(await password()).toBe('first');
    expect(sm.send).toHaveBeenCalledTimes(1);
    t = 31_000;
    expect(await password()).toBe('rotated');
  });

  it('rejects a secret without a password', async () => {
    const sm = client('');
    await expect(secretsManagerPassword('arn:secret', sm)()).rejects.toThrow(/no password/);
  });
});
