import { invoke } from '@tauri-apps/api/core';
import type { OtpCode } from '../vault/core.js';

export type { OtpCode };

/**
 * A one-time password setup that has been read and checked but not saved yet.
 * `uri` is what goes into the item's `totp` field.
 */
export interface OtpSetup {
  uri: string;
  issuer: string;
  account: string;
  current: OtpCode;
}

/** Bridge to the one-time password commands in the Rust core. */
export const otpCore = {
  /** Checks a pasted `otpauth://` link or a typed setup key. */
  parse: (input: string) => invoke<OtpSetup>('otp_parse', { input }),
  /** Crosshair selection over the screen (macOS); null if cancelled. */
  scanScreen: () => invoke<OtpSetup | null>('otp_scan_screen'),
  /** Picks an image file and reads its QR code; null if cancelled. */
  scanImage: () => invoke<OtpSetup | null>('otp_scan_image'),
};

export type OtpCore = typeof otpCore;
