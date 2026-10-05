import { afterEach, describe, expect, it, vi } from 'vitest';

const render = vi.hoisted(() => vi.fn());
vi.mock('react-dom/client', () => ({ createRoot: vi.fn(() => ({ render })) }));
vi.mock('./App.js', () => ({ App: () => null }));

afterEach(() => {
  vi.resetModules();
  render.mockClear();
  document.body.innerHTML = '';
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('main', () => {
  it('mounts the app and paints its own glass outside Tauri', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    await import('./main.js');
    expect(render).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.glass).toBe('painted');
  });

  it('uses native glass inside Tauri on a Mac', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    await import('./main.js');
    expect(document.documentElement.dataset.glass).toBe('native');
  });

  it('throws without a #root', async () => {
    await expect(import('./main.js')).rejects.toThrow('missing #root');
  });
});
