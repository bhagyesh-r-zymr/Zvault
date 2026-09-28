import { describe, expect, it, vi } from 'vitest';
import { Host, type NativePort } from './host.js';

function fakePort() {
  const sent: Record<string, unknown>[] = [];
  let onMessage: (m: unknown) => void = () => {};
  let onDisconnect: () => void = () => {};
  const port: NativePort = {
    postMessage: (m) => sent.push(m as Record<string, unknown>),
    onMessage: { addListener: (cb) => (onMessage = cb) },
    onDisconnect: { addListener: (cb) => (onDisconnect = cb) },
  };
  return {
    port,
    sent,
    reply: (m: unknown) => onMessage(m),
    close: () => onDisconnect(),
  };
}

describe('Host', () => {
  it('matches replies to requests by id and passes events along', async () => {
    const fake = fakePort();
    const host = new Host(
      () => fake.port,
      () => undefined,
    );
    const events: unknown[] = [];
    const pairing = host.request({ type: 'pair' }, (e) => events.push(e));
    const status = host.request({ type: 'status' });
    expect(fake.sent.map((m) => m.id)).toEqual([1, 2]);

    fake.reply({ id: 2, ok: true, running: true, paired: false });
    fake.reply({ id: 1, event: 'pairingCode', code: '123456' });
    fake.reply({ id: 1, ok: false, code: 'denied', message: 'no' });

    await expect(status).resolves.toEqual({
      ok: true,
      value: { id: 2, ok: true, running: true, paired: false },
    });
    await expect(pairing).resolves.toEqual({ ok: false, code: 'denied', message: 'no' });
    expect(events).toEqual([{ id: 1, event: 'pairingCode', code: '123456' }]);
  });

  it('says Zvault is not installed when Chrome cannot find the host', async () => {
    const fake = fakePort();
    const host = new Host(
      () => fake.port,
      () => 'Specified native messaging host not found.',
    );
    const r = host.request({ type: 'status' });
    fake.close();
    await expect(r).resolves.toMatchObject({ ok: false, code: 'notInstalled' });
  });

  it('reconnects after the host exits', async () => {
    const ports = [fakePort(), fakePort()];
    const connect = vi.fn(() => ports[connect.mock.calls.length - 1]!.port);
    const host = new Host(connect, () => undefined);
    const first = host.request({ type: 'status' });
    ports[0]!.close();
    await expect(first).resolves.toMatchObject({ ok: false, code: 'error' });
    const second = host.request({ type: 'status' });
    ports[1]!.reply({ id: 2, ok: true });
    await expect(second).resolves.toMatchObject({ ok: true });
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
