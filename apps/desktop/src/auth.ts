import { isTwoFactorRequired, type EncryptedBlob, type TwoFactorProof } from '@zvault/shared';
import { api, ApiRequestError } from './api.js';
import { core, type RecoveredAccount } from './core.js';
import { thisDevice } from './device.js';
import { lock } from './lock.js';

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
 * A login that passed the password step on an account with 2FA on. The
 * server has already proved itself; `complete` sends the code and unlocks.
 */
export interface TwoFactorChallenge {
  twoFactor: true;
  expiresAt: string;
  /** Rejects with the server's error (e.g. a wrong code); the challenge can be retried. */
  complete: (proof: TwoFactorProof) => Promise<Session>;
}

export const needsTwoFactor = (r: Session | TwoFactorChallenge): r is TwoFactorChallenge =>
  'twoFactor' in r;

/**
 * SRP login: the server sends its challenge, the Rust core answers it, and
 * the server's proof is checked before the keyset is opened. Accounts with
 * 2FA get a `TwoFactorChallenge` to finish with a code. A null `secretKey`
 * uses the one from a picked Emergency Kit or saved on this Mac; a successful
 * sign-in saves the key used to this Mac's Keychain.
 */
export async function signIn(
  email: string,
  password: string,
  secretKey: string | null,
): Promise<Session | TwoFactorChallenge> {
  const start = await api.loginStart(email);
  const proof = await core.loginProve({
    email,
    password,
    secretKey,
    kdf: start.kdf,
    srpB: start.srpB,
  });
  const finish = await api.loginFinish({
    loginId: start.loginId,
    ...proof,
    device: await thisDevice(),
  });
  if (!isTwoFactorRequired(finish)) return unlock(finish.srpM2, finish);

  // Never send a code to a server that can't prove it holds our verifier.
  await core.loginVerifyServer(finish.srpM2);
  return {
    twoFactor: true,
    expiresAt: finish.expiresAt,
    complete: async (proof) => {
      const session = await api.loginTwoFactor({ twoFactorToken: finish.twoFactorToken, proof });
      return unlock(finish.srpM2, session);
    },
  };
}

/** Opens the keyset with the server's session, dropping the session if anything is off. */
async function unlock(
  srpM2: string,
  session: { sessionToken: string; expiresAt: string; encryptedKeyset: EncryptedBlob },
): Promise<Session> {
  try {
    const unlocked = await core.loginFinish(srpM2, session.encryptedKeyset);
    return { email: unlocked.email, token: session.sessionToken, expiresAt: session.expiresAt };
  } catch (e) {
    // The server's proof or keyset didn't check out: don't keep its session.
    await api.logout(session.sessionToken).catch(() => undefined);
    throw e;
  }
}

/**
 * Reopens the session "Stay unlocked" saved at the last unlock, unless the
 * server has since ended it. Offline, the vault still opens: the key is local.
 */
export async function resumeSession(): Promise<Session | null> {
  const saved = await lock.restore().catch(() => null);
  if (!saved) return null;
  try {
    await api.session(saved.token);
  } catch (e) {
    if (e instanceof ApiRequestError && e.status === 401) {
      await signOut(saved);
      return null;
    }
  }
  return saved;
}

export async function signOut(session: Session): Promise<void> {
  await core.lock();
  await api.logout(session.token).catch(() => undefined);
}

/**
 * Changes the master password. The Secret Key and everything in the vault stay
 * as they are: the same keyset is sealed under the new password. The server
 * signs out every other device.
 */
export async function changeMasterPassword(
  session: Session,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const start = await api.loginStart(session.email);
  const change = await core.passwordChangeProve({
    currentPassword,
    newPassword,
    kdf: start.kdf,
    srpB: start.srpB,
  });
  const { srpM2 } = await api.changePassword(session.token, { loginId: start.loginId, ...change });
  await core.passwordChangeFinish(srpM2);
  // "Stay unlocked" keeps what the lock screen needs; refresh it for the new password.
  await lock.saveForRestart(session.token, session.expiresAt).catch(() => undefined);
}

/** Sets up or replaces the recovery code. Returns the new code, to show once. */
export async function setUpRecovery(session: Session, password: string): Promise<string> {
  const start = await api.loginStart(session.email);
  const setup = await core.recoverySetupProve({ password, kdf: start.kdf, srpB: start.srpB });
  const { srpM2 } = await api.setUpRecovery(session.token, { loginId: start.loginId, ...setup });
  return core.recoverySetupFinish(srpM2);
}

/** A recovery whose email code and recovery code checked out. */
export interface VerifiedRecovery {
  email: string;
  recoveryToken: string;
  recoveryKeyset: EncryptedBlob;
  twoFactorRequired: boolean;
}

/** Checks the emailed code and the recovery code with the server. */
export async function verifyRecovery(
  email: string,
  emailCode: string,
  recoveryCode: string,
): Promise<VerifiedRecovery> {
  const recoveryAuth = await core.recoverBegin(email, recoveryCode);
  const res = await api.recoverVerify({ email, code: emailCode, recoveryAuth });
  return { email, ...res };
}

/** Makes the new keys on this Mac. The result can be retried with `finishRecovery`. */
export const prepareRecovery = (verified: VerifiedRecovery, newPassword: string) =>
  core.recoverReset(newPassword, verified.recoveryKeyset);

/**
 * Uploads the new keys, then unlocks. Returns the new session and the new
 * recovery code, which the person must save along with the new Emergency Kit.
 */
export async function finishRecovery(
  verified: VerifiedRecovery,
  account: RecoveredAccount,
  twoFactor: TwoFactorProof | undefined,
): Promise<{ session: Session; recoveryCode: string }> {
  const done = await api.recoverComplete({
    recoveryToken: verified.recoveryToken,
    ...(twoFactor ? { twoFactor } : {}),
    ...account,
    device: await thisDevice(),
  });
  const finished = await core.recoverFinish();
  return {
    session: { email: finished.email, token: done.sessionToken, expiresAt: done.expiresAt },
    recoveryCode: finished.recoveryCode,
  };
}

export const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === 'string' ? e : 'Something went wrong.';
