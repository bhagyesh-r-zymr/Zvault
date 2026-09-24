import { z } from 'zod';

/**
 * What a client says about itself when it signs in. Shown back to the user in
 * the device list so they can recognise (and revoke) their own sessions.
 */
export const DeviceInfo = z.object({
  name: z.string().trim().min(1).max(64),
  platform: z.enum(['macos', 'windows', 'linux', 'ios', 'android', 'web', 'cli']),
  appVersion: z
    .string()
    .max(32)
    .regex(/^[0-9A-Za-z.+-]+$/),
});
export type DeviceInfo = z.infer<typeof DeviceInfo>;

export const SessionId = z.uuid();

/** One signed-in session as the user sees it. Never includes the token. */
export const DeviceSession = z.object({
  id: SessionId,
  device: DeviceInfo,
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  /** True for the session that made this request. */
  current: z.boolean(),
});
export type DeviceSession = z.infer<typeof DeviceSession>;

export const ListDevicesResponse = z.object({
  devices: z.array(DeviceSession),
});
export type ListDevicesResponse = z.infer<typeof ListDevicesResponse>;

export const RevokeSessionsResponse = z.object({
  revoked: z.number().int().nonnegative(),
});
export type RevokeSessionsResponse = z.infer<typeof RevokeSessionsResponse>;
