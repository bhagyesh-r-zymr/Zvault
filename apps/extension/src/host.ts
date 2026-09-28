import type { ErrorCode, Result } from './messages.js';

/** `zv`, registered by the Zvault app as this extension's native host. */
export const HOST_NAME = 'com.zvault.browser';

/** Longer than Zvault waits for a person to answer a prompt. */
const REPLY_TIMEOUT_MS = 200_000;

type Reply = { ok: true } & Record<string, unknown>;
type Failure = { ok: false; code: ErrorCode; message: string };

interface Pending {
  done: (r: Result<Reply>) => void;
  onEvent: ((event: Record<string, unknown>) => void) | undefined;
  timer: ReturnType<typeof setTimeout>;
}

/** The port a {@link Host} opens; `chrome.runtime.Port` in the browser. */
export interface NativePort {
  postMessage(message: unknown): void;
  onMessage: { addListener(cb: (message: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
}

/**
 * One connection to `zv`, opened on first use and reopened after it closes.
 * Requests carry an id that the reply repeats, so several can be in flight.
 */
export class Host {
  private port: NativePort | null = null;
  private next = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly connect: () => NativePort = () => chrome.runtime.connectNative(HOST_NAME),
    private readonly lastError: () => string | undefined = () => chrome.runtime.lastError?.message,
  ) {}

  request<T extends Record<string, unknown>>(
    message: Record<string, unknown>,
    onEvent?: (event: Record<string, unknown>) => void,
  ): Promise<Result<T & Reply>> {
    return new Promise((resolve) => {
      const id = this.next++;
      const timer = setTimeout(
        () => this.finish(id, { ok: false, code: 'timeout', message: 'Zvault did not answer.' }),
        REPLY_TIMEOUT_MS,
      );
      this.pending.set(id, {
        done: resolve as (r: Result<Reply>) => void,
        onEvent,
        timer,
      });
      try {
        this.open().postMessage({ ...message, id });
      } catch {
        this.finish(id, { ok: false, code: 'notInstalled', message: 'Zvault is not installed.' });
      }
    });
  }

  private open(): NativePort {
    if (this.port) return this.port;
    const port = this.connect();
    port.onMessage.addListener((m) => this.receive(m));
    port.onDisconnect.addListener(() => {
      const why = this.lastError() ?? '';
      if (this.port === port) this.port = null;
      // Chrome says "Specified native messaging host not found." until the
      // Zvault app has registered zv.
      const code: ErrorCode = /not found|forbidden|not allowed/i.test(why)
        ? 'notInstalled'
        : 'error';
      for (const id of [...this.pending.keys()]) {
        this.finish(id, { ok: false, code, message: why || 'Lost the connection to Zvault.' });
      }
    });
    this.port = port;
    return port;
  }

  private receive(message: unknown) {
    if (typeof message !== 'object' || message === null) return;
    const m = message as Record<string, unknown>;
    const id = typeof m.id === 'number' ? m.id : null;
    const entry = id === null ? undefined : this.pending.get(id);
    if (!entry || id === null) return;
    if (typeof m.event === 'string') {
      entry.onEvent?.(m);
      return;
    }
    if (m.ok === true) {
      this.finish(id, { ok: true, value: m as Reply });
    } else {
      const f = m as Partial<Failure>;
      this.finish(id, {
        ok: false,
        code: f.code ?? 'error',
        message: typeof f.message === 'string' ? f.message : 'Zvault could not do that.',
      });
    }
  }

  private finish(id: number, result: Result<Reply>) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.done(result);
  }
}
