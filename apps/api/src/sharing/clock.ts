/** Injectable clock so expiry can be tested. */
export const SHARE_CLOCK = Symbol('SHARE_CLOCK');
export type Clock = () => Date;
