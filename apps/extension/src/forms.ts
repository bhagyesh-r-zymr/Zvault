/**
 * Finding login and one-time code fields, and typing into them the way a
 * person would, so sites built with React and friends notice the change.
 *
 * Pure DOM code shared by the content script and its tests.
 */

export type Role = 'username' | 'password' | 'otp';

/** Whether a field is on screen. Tests replace it; happy-dom has no layout. */
export type Visible = (el: HTMLElement) => boolean;

export const isVisible: Visible = (el) => {
  if (el.hidden || el.closest('[hidden],[aria-hidden="true"]')) return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')
    return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 4 && rect.height > 4;
};

const TEXT_TYPES = new Set(['', 'text', 'email', 'tel', 'number']);
const USERNAME_HINT = /user|email|e-mail|login|account|member|phone|mobile|identifier|handle/i;
const OTP_HINT =
  /one[-_ ]?time|otp|totp|2fa|two[-_ ]?factor|mfa|verification[-_ ]?code|verify[-_ ]?code|auth(entication)?[-_ ]?code|security[-_ ]?code|passcode|token|pin[-_ ]?code/i;
const NOT_OTP_HINT = /search|captcha|coupon|promo|zip|postal|card|cvc|cvv/i;

function describe(input: HTMLInputElement): string {
  return [
    input.name,
    input.id,
    input.placeholder,
    input.getAttribute('aria-label') ?? '',
    input.labels?.[0]?.textContent ?? '',
  ].join(' ');
}

function usable(input: HTMLInputElement, visible: Visible): boolean {
  return !input.disabled && !input.readOnly && visible(input);
}

function inputs(root: ParentNode): HTMLInputElement[] {
  return Array.from(root.querySelectorAll('input'));
}

/** Password fields a person could type into. */
export function passwordFields(root: ParentNode, visible: Visible = isVisible) {
  return inputs(root).filter((i) => i.type === 'password' && usable(i, visible));
}

function isTextLike(input: HTMLInputElement): boolean {
  return TEXT_TYPES.has(input.type.toLowerCase());
}

/** A single field for a whole one-time code. */
function isOtpField(input: HTMLInputElement): boolean {
  if (!isTextLike(input) && input.type !== 'password') return false;
  const auto = (input.getAttribute('autocomplete') ?? '').toLowerCase();
  if (auto.includes('one-time-code')) return true;
  if (input.type === 'password') return false;
  const text = describe(input);
  if (NOT_OTP_HINT.test(text)) return false;
  if (OTP_HINT.test(text)) return true;
  // A short numeric box on its own, like <input inputmode=numeric maxlength=6>.
  const max = input.maxLength;
  return input.inputMode === 'numeric' && max >= 6 && max <= 8;
}

/**
 * The fields a one-time code goes into: one field, or a row of four to eight
 * one-character boxes. Empty when the page has none.
 */
export function otpFields(root: ParentNode, visible: Visible = isVisible): HTMLInputElement[] {
  const all = inputs(root).filter((i) => usable(i, visible));
  const single = all.find(isOtpField);
  if (single && single.maxLength !== 1) return [single];
  const boxes = all.filter((i) => i.maxLength === 1 && (isTextLike(i) || i.type === 'password'));
  // Boxes sit side by side, each alone in a wrapper or all in one container.
  const container = (b: HTMLInputElement) =>
    b.parentElement?.children.length === 1 ? b.parentElement.parentElement : b.parentElement;
  for (const first of boxes) {
    const row = boxes.filter((b) => container(b) === container(first));
    if (row.length >= 4 && row.length <= 8) return row;
  }
  return [];
}

/**
 * The user name field that goes with a password field: in the same form, the
 * nearest text field before it, preferring ones that look like a user name.
 */
export function usernameFieldFor(
  password: HTMLInputElement,
  visible: Visible = isVisible,
): HTMLInputElement | null {
  const scope: ParentNode = password.form ?? password.ownerDocument;
  const before = inputs(scope).filter(
    (i) =>
      isTextLike(i) &&
      usable(i, visible) &&
      !isOtpField(i) &&
      i.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  const hinted = before.filter((i) => {
    const auto = (i.getAttribute('autocomplete') ?? '').toLowerCase();
    return (
      auto === 'username' ||
      auto === 'email' ||
      i.type === 'email' ||
      USERNAME_HINT.test(describe(i))
    );
  });
  return hinted.at(-1) ?? before.at(-1) ?? null;
}

/**
 * The user name field of a page that asks for it alone first (Google,
 * Microsoft and many others), when there is no password field yet.
 */
export function loneUsernameField(
  root: ParentNode,
  visible: Visible = isVisible,
): HTMLInputElement | null {
  return (
    inputs(root).find((i) => {
      if (!isTextLike(i) || !usable(i, visible) || isOtpField(i)) return false;
      const auto = (i.getAttribute('autocomplete') ?? '').toLowerCase();
      return (
        auto === 'username' ||
        auto === 'email' ||
        i.type === 'email' ||
        USERNAME_HINT.test(describe(i))
      );
    }) ?? null
  );
}

/** What a focused field is for, if it is one we fill. */
export function roleOf(input: HTMLInputElement, visible: Visible = isVisible): Role | null {
  if (!usable(input, visible)) return null;
  if (
    isOtpField(input) ||
    (input.maxLength === 1 && otpFields(input.ownerDocument, visible).includes(input))
  )
    return 'otp';
  if (input.type === 'password') return 'password';
  if (!isTextLike(input)) return null;
  const form: ParentNode = input.form ?? input.ownerDocument;
  const pw = passwordFields(form, visible).find(
    (p) => input.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  if (pw && usernameFieldFor(pw, visible) === input) return 'username';
  if (!pw && loneUsernameField(input.ownerDocument, visible) === input) return 'username';
  return null;
}

/** Sets a field's value through the native setter and tells the page. */
export function setValue(input: HTMLInputElement, value: string): void {
  input.focus();
  // The prototype's setter, not the field's own: React replaces the latter
  // to track changes and would otherwise not see this one.
  if (!Reflect.set(HTMLInputElement.prototype, 'value', value, input)) input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Types a one-time code into its field or boxes. */
export function fillOtp(fields: HTMLInputElement[], code: string): boolean {
  if (fields.length === 0) return false;
  if (fields.length === 1) {
    setValue(fields[0]!, code);
    return true;
  }
  fields.forEach((f, i) => setValue(f, code[i] ?? ''));
  return true;
}

export interface LoginFill {
  username: string;
  password: string;
  otp?: string | null;
}

/**
 * Fills the login form around `near` (a focused field) or the first one on
 * the page. Returns whether anything was filled.
 */
export function fillLogin(
  root: Document,
  fill: LoginFill,
  near: HTMLInputElement | null = null,
  visible: Visible = isVisible,
): boolean {
  const scope: ParentNode = near?.form ?? root;
  let password =
    near?.type === 'password'
      ? near
      : (passwordFields(scope, visible).find(
          (p) => !near || near.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING,
        ) ??
        passwordFields(root, visible)[0] ??
        null);
  if (password && near && near.form && password.form !== near.form) password = null;
  const user = password
    ? usernameFieldFor(password, visible)
    : near && isTextLike(near)
      ? near
      : loneUsernameField(root, visible);
  let filled = false;
  if (user && fill.username) {
    setValue(user, fill.username);
    filled = true;
  }
  if (password && fill.password) {
    setValue(password, fill.password);
    filled = true;
  }
  if (fill.otp) {
    const otp = otpFields(password?.form ?? root, visible);
    if (otp.length && !(password && otp.includes(password)))
      filled = fillOtp(otp, fill.otp) || filled;
  }
  return filled;
}

/** A user name and password someone typed into a page. */
export interface TypedLogin {
  username: string;
  password: string;
}

/** The longest values offered for saving; Zvault refuses longer ones. */
const MAX_USERNAME = 512;
const MAX_PASSWORD = 1024;

/**
 * The login typed into the form around `near` (the form being sent, or the
 * button or field that sends it), or anywhere on the page when it has no
 * form. For a sign-up or change-password form, the new password. Null when
 * no password was typed.
 */
export function typedLogin(
  root: Document,
  near: Element | null,
  visible: Visible = isVisible,
): TypedLogin | null {
  const form =
    near instanceof HTMLFormElement
      ? near
      : near instanceof HTMLInputElement || near instanceof HTMLButtonElement
        ? near.form
        : (near?.closest('form') ?? null);
  const filled = inputs(form ?? root).filter(
    (i) => i.type === 'password' && i.value && !isOtpField(i) && i.maxLength !== 1,
  );
  // One field: the password. Two: current and new, or new and confirm; the
  // second is new either way. Three: current, new and confirm.
  const password = filled.length >= 3 ? filled[1] : filled.at(-1);
  if (!password || password.value.length > MAX_PASSWORD) return null;
  const username = (usernameFieldFor(password, visible)?.value ?? '').trim();
  return { username: username.length <= MAX_USERNAME ? username : '', password: password.value };
}
