/** Injectable clock so pairing expiry can be tested. */
export const PAIRING_CLOCK = Symbol('PAIRING_CLOCK');
export type Clock = () => Date;
