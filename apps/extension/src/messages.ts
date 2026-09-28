/**
 * What the extension's parts say to each other, and what `zv` answers.
 *
 * The popup and the content scripts ask the background service worker; it
 * alone talks to `zv` (the native messaging host), which asks the Zvault app.
 * The app decides which logins a page may see, from the page address the
 * browser reports for the asking frame, never one a content script claims.
 */

/** Why a request did not work. Mirrors the codes `zv` sends. */
export type ErrorCode =
  /** Zvault for Mac is not installed, or has never been opened. */
  | 'notInstalled'
  /** Zvault is installed but not running. */
  | 'notRunning'
  | 'notPaired'
  | 'locked'
  | 'paused'
  | 'denied'
  | 'timeout'
  | 'notFound'
  | 'wrongSite'
  | 'busy'
  | 'badRequest'
  /** The page cannot be filled (a browser page, or no login form). */
  | 'noForm'
  | 'error';

export type Result<T> = { ok: true; value: T } | { ok: false; code: ErrorCode; message: string };

/** A login saved for the page: never its password. */
export interface Login {
  id: string;
  title: string;
  username: string;
  /** The saved website that matched. */
  url: string;
  hasTotp: boolean;
}

/** What to type into the page. */
export interface Fill {
  username: string;
  /** Empty when only the one-time code was asked for. */
  password: string;
  otp: string | null;
  otpRemaining: number | null;
}

export interface Status {
  /** Zvault is open. */
  running: boolean;
  locked: boolean;
  /** This browser is connected to Zvault. */
  paired: boolean;
  name?: string;
  paused?: boolean;
}

/** Requests to the background worker. */
export type Request =
  | { type: 'status' }
  | { type: 'pair' }
  | { type: 'unpair' }
  | { type: 'unlock' }
  /** From a content script: logins for the frame that sent it. */
  | { type: 'logins' }
  /** From a content script: fill the frame that sent it. */
  | { type: 'fill'; item: string; otpOnly: boolean }
  /** From a content script on a code field: the login just filled in this tab. */
  | { type: 'lastFilled' }
  /** From the popup: logins for a tab's page. */
  | { type: 'tabLogins'; tabId: number }
  /** From the popup: fill a tab's page. */
  | { type: 'tabFill'; tabId: number; item: string; otpOnly: boolean }
  /** From the popup: a login's current one-time code, to copy. */
  | { type: 'tabCode'; tabId: number; item: string }
  /** From a content script: a login was typed and sent in the frame. */
  | { type: 'typed'; username: string; password: string }
  /** From a content script: a user name was sent alone, before the password page. */
  | { type: 'typedUsername'; username: string }
  /** From a top frame as it loads: a login waiting to be saved, if any. */
  | { type: 'saveOffer' }
  /** From a top frame's save banner. */
  | { type: 'save' }
  | { type: 'dismissSave' };

/** A typed login Zvault does not have yet, offered for saving. */
export interface SaveOffer {
  /** The website it would be saved for. */
  host: string;
  username: string;
  /** The title of the saved login whose password changed, if any. */
  update: string | null;
}

/** From the background worker to a tab's top frame: show the save banner. */
export interface OfferSave {
  type: 'offerSave';
  offer: SaveOffer;
}

/** What `zv` says about a typed login. */
export type SaveCheck =
  { state: 'new' } | { state: 'update'; item: string; title: string } | { state: 'saved' };

/** From the background worker to a tab's top frame. */
export interface FillNow {
  type: 'fillNow';
  /** The origin the fill was approved for; the page must still be on it. */
  origin: string;
  fill: Fill;
  otpOnly: boolean;
}

/** From the background worker to an open popup. */
export interface PairingCode {
  type: 'pairingCode';
  code: string;
}

/** What each code means, for people. */
export const ERROR_TEXT: Record<ErrorCode, string> = {
  notInstalled: 'Install Zvault for Mac and open it once.',
  notRunning: 'Open Zvault on your Mac.',
  notPaired: 'Connect this browser to Zvault first.',
  locked: 'Zvault is locked.',
  paused: 'This browser is paused in Zvault.',
  denied: 'You declined in Zvault.',
  timeout: 'Nobody answered in Zvault.',
  notFound: 'That login is no longer in Zvault.',
  wrongSite: 'That login is not saved for this website.',
  busy: 'Zvault is showing another request.',
  badRequest: 'Zvault could not read that request.',
  noForm: 'No login form on this page.',
  error: 'Something went wrong.',
};
