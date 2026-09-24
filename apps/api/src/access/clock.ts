/** Injectable clock so tests can move time (grant end dates, request expiry). */
export type Clock = () => Date;
export const ACCESS_CLOCK = Symbol('ACCESS_CLOCK');
