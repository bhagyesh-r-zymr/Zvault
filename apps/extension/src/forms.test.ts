// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  fillLogin,
  fillOtp,
  otpFields,
  passwordFields,
  roleOf,
  usernameFieldFor,
} from './forms.js';

const shown = () => true;

function page(html: string) {
  document.body.innerHTML = html;
}

function input(selector: string): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(selector)!;
}

beforeEach(() => page(''));

describe('finding login fields', () => {
  it('pairs the password with the user name field before it in the same form', () => {
    page(`
      <input id="search" type="text" name="q">
      <form>
        <input id="email" type="email" name="email">
        <input id="pw" type="password" name="password">
      </form>`);
    const pw = passwordFields(document, shown)[0]!;
    expect(pw.id).toBe('pw');
    expect(usernameFieldFor(pw, shown)?.id).toBe('email');
    expect(roleOf(input('#email'), shown)).toBe('username');
    expect(roleOf(input('#pw'), shown)).toBe('password');
    expect(roleOf(input('#search'), shown)).toBeNull();
  });

  it('prefers a field that looks like a user name over another text field', () => {
    page(`
      <form>
        <input id="login" name="login">
        <input id="company" name="company">
        <input id="pw" type="password">
      </form>`);
    expect(usernameFieldFor(input('#pw'), shown)?.id).toBe('login');
  });

  it('recognises a user name page with no password field yet', () => {
    page(`<form><input id="id" type="email" autocomplete="username"><button>Next</button></form>`);
    expect(roleOf(input('#id'), shown)).toBe('username');
  });

  it('skips disabled, read-only and hidden fields', () => {
    page(
      `<form><input type="password" disabled><input type="password" readonly><input id="pw" type="password"></form>`,
    );
    expect(passwordFields(document, shown).map((p) => p.id)).toEqual(['pw']);
    expect(passwordFields(document, (e) => e.id !== 'pw')).toEqual([]);
  });
});

describe('finding one-time code fields', () => {
  it('finds a field marked for one-time codes', () => {
    page(`<form><input id="code" autocomplete="one-time-code" inputmode="numeric"></form>`);
    expect(otpFields(document, shown).map((i) => i.id)).toEqual(['code']);
    expect(roleOf(input('#code'), shown)).toBe('otp');
  });

  it('finds a field named like a code, but not a search or coupon box', () => {
    page(`<input id="coupon" name="coupon_code"><input id="totp" name="totp_code">`);
    expect(otpFields(document, shown).map((i) => i.id)).toEqual(['totp']);
  });

  it('finds a row of one-character boxes', () => {
    page(
      `<div>${[1, 2, 3, 4, 5, 6].map((n) => `<input id="d${n}" maxlength="1" inputmode="numeric">`).join('')}</div>`,
    );
    const boxes = otpFields(document, shown);
    expect(boxes).toHaveLength(6);
    expect(roleOf(input('#d3'), shown)).toBe('otp');
    fillOtp(boxes, '123456');
    expect(boxes.map((b) => b.value).join('')).toBe('123456');
  });

  it('finds no code field on a plain login form', () => {
    page(`<form><input name="username"><input type="password"></form>`);
    expect(otpFields(document, shown)).toEqual([]);
  });
});

describe('filling', () => {
  it('fills the user name and password and tells the page', () => {
    page(`<form><input id="u" name="username"><input id="p" type="password"></form>`);
    const seen: string[] = [];
    document.addEventListener('input', (e) => seen.push((e.target as HTMLInputElement).id));
    expect(
      fillLogin(document, { username: 'me@example.com', password: 's3cret' }, null, shown),
    ).toBe(true);
    expect(input('#u').value).toBe('me@example.com');
    expect(input('#p').value).toBe('s3cret');
    expect(seen).toEqual(['u', 'p']);
  });

  it('fills the form of the focused field, not another one', () => {
    page(`
      <form id="signup"><input id="su" name="email"><input id="sp" type="password"></form>
      <form id="signin"><input id="iu" name="email"><input id="ip" type="password"></form>`);
    fillLogin(document, { username: 'me', password: 'pw' }, input('#iu'), shown);
    expect(input('#iu').value).toBe('me');
    expect(input('#ip').value).toBe('pw');
    expect(input('#su').value).toBe('');
    expect(input('#sp').value).toBe('');
  });

  it('fills a code field on the same form when the login has one', () => {
    page(
      `<form><input id="u" name="user"><input id="p" type="password"><input id="c" name="otp"></form>`,
    );
    fillLogin(document, { username: 'me', password: 'pw', otp: '654321' }, null, shown);
    expect(input('#c').value).toBe('654321');
  });

  it('fills only the user name on a user-name-first page', () => {
    page(`<form><input id="u" type="email" name="identifier"></form>`);
    expect(
      fillLogin(document, { username: 'me@example.com', password: 'pw' }, input('#u'), shown),
    ).toBe(true);
    expect(input('#u').value).toBe('me@example.com');
  });

  it('reports when there is nothing to fill', () => {
    page(`<p>Hello</p>`);
    expect(fillLogin(document, { username: 'me', password: 'pw' }, null, shown)).toBe(false);
  });
});
