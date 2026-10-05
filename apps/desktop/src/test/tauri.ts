import { mockIPC } from '@tauri-apps/api/mocks';
import { vi } from 'vitest';

type IpcHandler = (args: Record<string, unknown>) => unknown;
type Handler = IpcHandler | object | string | number | boolean | null | undefined;

/**
 * Answers Tauri `invoke` calls from a map of command name to handler. A command
 * with no handler rejects, so a test notices a call it did not expect. Returns
 * a spy that records every call as `[command, args]`.
 */
export function mockCore(handlers: Record<string, Handler> = {}) {
  const calls = vi.fn<(cmd: string, args: Record<string, unknown>) => void>();
  mockIPC(
    (cmd, args) => {
      if (cmd.startsWith('plugin:event|')) return 0;
      calls(cmd, (args ?? {}) as Record<string, unknown>);
      if (!(cmd in handlers)) throw new Error(`unexpected command: ${cmd}`);
      const h = handlers[cmd];
      return typeof h === 'function'
        ? (h as IpcHandler)((args ?? {}) as Record<string, unknown>)
        : h;
    },
    { shouldMockEvents: true },
  );
  return calls;
}

type Route = (req: { url: URL; method: string; body: unknown }) => unknown;

/**
 * Stubs global `fetch` with JSON routes keyed `"METHOD /v1/path"`. A route
 * returns the JSON body, or a `Response` for a custom status. Unknown routes
 * answer 404.
 */
export function mockFetch(
  routes: Record<string, Route | object | string | number | boolean | null>,
) {
  const spy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    const route = routes[`${method} ${url.pathname}`];
    if (route === undefined)
      return Promise.resolve(
        new Response(JSON.stringify({ message: 'not found' }), { status: 404 }),
      );
    const out = typeof route === 'function' ? (route as Route)({ url, method, body }) : route;
    if (out instanceof Response) return Promise.resolve(out);
    return Promise.resolve(
      new Response(JSON.stringify(out), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}
