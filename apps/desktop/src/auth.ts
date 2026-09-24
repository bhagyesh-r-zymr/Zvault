import { api } from './api.js';
import { core } from './core.js';

export const MIN_PASSWORD_LENGTH = 10;

export interface Session {
  email: string;
  token: string;
  expiresAt: string;
}

/** Why a proposed master password is unacceptable, or null if it's fine. */
export function passwordProblem(password: string, confirm: string, email: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.trim().toLowerCase() === email.trim().toLowerCase()) {
    return "Your master password can't be your email address.";
  }
  if (password !== confirm) return "The passwords don't match.";
  return null;
}

/**
 * Creates the account's keys on this device and registers them. Returns the
 * Secret Key for the Emergency Kit.
 */
export async function createAccount(
  email: string,
  password: string,
  signupToken: string,
): Promise<string> {
  const account = await core.createAccount(email, password);
  await api.signupComplete({
    signupToken,
    secretKeyId: account.secretKeyId,
    kdf: account.kdf,
    srpVerifier: account.srpVerifier,
    encryptedKeyset: account.encryptedKeyset,
  });
  return account.secretKey;
}

/**
 * SRP login: the server sends its challenge, the Rust core answers it, and
 * the server's proof is checked before the keyset is opened.
 */
export async function signIn(email: string, password: string, secretKey: string): Promise<Session> {
  const start = await api.loginStart(email);
  const proof = await core.loginProve({
    email,
    password,
    secretKey,
    kdf: start.kdf,
    srpB: start.srpB,
  });
  const finish = await api.loginFinish({ loginId: start.loginId, ...proof });
  try {
    const unlocked = await core.loginFinish(finish.srpM2, finish.encryptedKeyset);
    return { email: unlocked.email, token: finish.sessionToken, expiresAt: finish.expiresAt };
  } catch (e) {
    // The server's proof or keyset didn't check out: don't keep its session.
    await api.logout(finish.sessionToken).catch(() => undefined);
    throw e;
  }
}

export async function signOut(session: Session): Promise<void> {
  await core.lock();
  await api.logout(session.token).catch(() => undefined);
}

export const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === 'string' ? e : 'Something went wrong.';
