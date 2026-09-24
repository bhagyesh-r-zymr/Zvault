import type { OtpCode } from './core.js';

/** A fetched code and when it was fetched (ms since the epoch). */
export interface FetchedCode {
  code: OtpCode;
  fetchedAt: number;
}

/** Whole seconds the code has left at `now`, never below 0. */
export function secondsLeft(f: FetchedCode, now: number): number {
  return Math.max(0, f.code.remaining - Math.floor((now - f.fetchedAt) / 1000));
}

/** Groups digits for reading aloud or typing: 123 456, 1234 5678. */
export function formatCode(code: string): string {
  const half = Math.ceil(code.length / 2);
  return `${code.slice(0, half)} ${code.slice(half)}`;
}
