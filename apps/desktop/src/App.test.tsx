import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CRYPTO_VERSION } from '@zvault/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const s = { email: 'a@b.co', token: 'tok', expiresAt: 'exp' };
const verified = {
  email: 'a@b.co',
  recoveryToken: 'r',
  recoveryKeyset: {},
  twoFactorRequired: false,
};

const h = vi.hoisted(() => ({ onLocked: null as null | ((r: string) => void) }));

vi.mock('./auth.js', () => ({ resumeSession: vi.fn(), signOut: vi.fn() }));
vi.mock('./core.js', () => ({
  core: {
    rememberedAccount: vi.fn(),
    info: vi.fn(),
    recoverCancel: vi.fn(),
    forgetSecretKey: vi.fn(),
  },
}));
vi.mock('./lock.js', () => ({
  lock: { onLocked: vi.fn(), status: vi.fn(), saveForRestart: vi.fn() },
  useActivityReporter: vi.fn(),
}));
vi.mock('./updates/UpdateBanner.js', () => ({ UpdateBanner: () => <i data-testid="banner" /> }));
vi.mock('./EmergencyKitStep.js', () => ({
  EmergencyKitStep: (p: { email: string; onDone: () => void }) => (
    <button onClick={p.onDone}>kit-done {p.email}</button>
  ),
}));
vi.mock('./LockScreen.js', () => ({
  LockScreen: (p: { reason: string; onUnlocked: () => void; onSignOut: () => void }) => (
    <div>
      locked:{p.reason}
      <button onClick={p.onUnlocked}>unlock</button>
      <button onClick={p.onSignOut}>lock-signout</button>
    </div>
  ),
}));
vi.mock('./screens/Login.js', () => ({
  Login: (p: {
    email?: string;
    secretKey?: string;
    remembered: unknown;
    onSignedIn: (x: typeof s) => void;
    onCreateAccount: () => void;
    onForgotPassword: (e: string) => void;
  }) => (
    <div>
      login:{p.email ?? 'none'}:{p.secretKey ?? 'nokey'}:{p.remembered ? 'remembered' : 'forgotten'}
      <button onClick={() => p.onSignedIn(s)}>signed-in</button>
      <button onClick={p.onCreateAccount}>create</button>
      <button onClick={() => p.onForgotPassword('x@b.co')}>forgot</button>
      <button onClick={() => p.onForgotPassword('')}>forgot-empty</button>
    </div>
  ),
}));
vi.mock('./screens/Recover.js', () => ({
  RecoverEmail: (p: { email?: string; onSent: (e: string) => void; onBack: () => void }) => (
    <div>
      recover-email:{p.email ?? 'none'}
      <button onClick={() => p.onSent('x@b.co')}>sent</button>
      <button onClick={p.onBack}>back</button>
    </div>
  ),
  RecoverCodes: (p: { email: string; onVerified: (v: unknown) => void; onBack: () => void }) => (
    <div>
      recover-codes:{p.email}
      <button onClick={() => p.onVerified(verified)}>verified</button>
      <button onClick={p.onBack}>back</button>
    </div>
  ),
  RecoverPassword: (p: { onRecovered: (r: unknown) => void; onBack: () => void }) => (
    <div>
      recover-password
      <button onClick={() => p.onRecovered({ session: s, recoveryCode: 'R1' })}>recovered</button>
      <button onClick={p.onBack}>back</button>
    </div>
  ),
  RecoveredKits: (p: { email: string; recoveryCode: string; onDone: () => void }) => (
    <div>
      kits:{p.email}:{p.recoveryCode}
      <button onClick={p.onDone}>kits-done</button>
    </div>
  ),
}));
vi.mock('./screens/Signup.js', () => ({
  SignupEmail: (p: { onSent: (e: string) => void; onSignIn: () => void }) => (
    <div>
      signup-email
      <button onClick={() => p.onSent('n@b.co')}>sent</button>
      <button onClick={p.onSignIn}>signin</button>
    </div>
  ),
  SignupCode: (p: { email: string; onVerified: (t: string) => void; onBack: () => void }) => (
    <div>
      signup-code:{p.email}
      <button onClick={() => p.onVerified('tok')}>verified</button>
      <button onClick={p.onBack}>back</button>
    </div>
  ),
  SignupPassword: (p: { email: string; signupToken: string; onCreated: (k: string) => void }) => (
    <div>
      signup-password:{p.email}:{p.signupToken}
      <button onClick={() => p.onCreated('Z1-KEY')}>created</button>
    </div>
  ),
}));
vi.mock('./shell/AppShell.js', () => ({
  AppShell: (p: {
    session: typeof s;
    lockStatus: unknown;
    onLockChanged: () => void;
    onForgetSecretKey: () => Promise<void>;
    onSignOut: () => void;
  }) => (
    <div>
      shell:{p.session.email}:{p.lockStatus ? 'status' : 'nostatus'}
      <button onClick={p.onLockChanged}>lock-changed</button>
      <button onClick={() => void p.onForgetSecretKey()}>forget</button>
      <button onClick={p.onSignOut}>signout</button>
    </div>
  ),
}));

const { resumeSession, signOut } = await import('./auth.js');
const { core } = await import('./core.js');
const { lock } = await import('./lock.js');
const { App } = await import('./App.js');

const lockStatus = (stayUnlocked = false) => ({
  locked: false,
  accountId: 'a',
  unlockMethod: 'masterPassword',
  settings: {
    idleTimeoutMins: 5,
    lockOnSleep: true,
    lockOnScreenLock: true,
    clipboardClearSecs: 30,
    stayUnlocked,
  },
  touchId: { available: false, enrolled: false },
});

const click = (name: string | RegExp) => userEvent.click(screen.getByRole('button', { name }));

beforeEach(() => {
  vi.resetAllMocks();
  h.onLocked = null;
  vi.mocked(resumeSession).mockResolvedValue(null);
  vi.mocked(signOut).mockResolvedValue(undefined);
  vi.mocked(core.rememberedAccount).mockResolvedValue(null);
  vi.mocked(core.info).mockResolvedValue({ cryptoVersion: CRYPTO_VERSION, aead: 'a', kdf: 'k' });
  vi.mocked(core.recoverCancel).mockResolvedValue(undefined);
  vi.mocked(core.forgetSecretKey).mockResolvedValue(undefined);
  vi.mocked(lock.onLocked).mockImplementation((fn) => {
    h.onLocked = fn as never;
    return Promise.resolve(() => undefined);
  });
  vi.mocked(lock.status).mockResolvedValue(lockStatus() as never);
  vi.mocked(lock.saveForRestart).mockResolvedValue(undefined);
});

describe('App', () => {
  it('starts on the sign-in screen and greets a remembered account', async () => {
    vi.mocked(core.rememberedAccount).mockResolvedValue({ email: 'me@b.co', secretKeyId: 'K' });
    render(<App />);
    expect(await screen.findByText('login:me@b.co:nokey:remembered')).toBeInTheDocument();
    expect(screen.getByTestId('banner')).toBeInTheDocument();
  });

  it('survives a failing remembered-account lookup', async () => {
    vi.mocked(core.rememberedAccount).mockRejectedValue(new Error('x'));
    render(<App />);
    expect(await screen.findByText('login:none:nokey:forgotten')).toBeInTheDocument();
  });

  it('warns when the crypto core is out of sync or unavailable', async () => {
    vi.mocked(core.info).mockResolvedValue({
      cryptoVersion: CRYPTO_VERSION + 1,
      aead: '',
      kdf: '',
    });
    const { unmount } = render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/out of sync/);
    unmount();
    vi.mocked(core.info).mockRejectedValue('gone');
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Rust core unavailable: gone');
  });

  it('opens straight into the vault with a resumed session and keeps it for restart', async () => {
    vi.mocked(resumeSession).mockResolvedValue(s);
    vi.mocked(lock.status).mockResolvedValue(lockStatus(true) as never);
    render(<App />);
    expect(await screen.findByText('shell:a@b.co:status')).toBeInTheDocument();
    await waitFor(() => expect(lock.saveForRestart).toHaveBeenCalledWith('tok', 'exp'));
  });

  it('shows a lock status failure as a banner', async () => {
    vi.mocked(resumeSession).mockResolvedValue(s);
    vi.mocked(lock.status).mockRejectedValue('no status');
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('no status');
  });

  it('signs in, refreshes lock status, forgets the key, and signs out', async () => {
    render(<App />);
    await screen.findByText(/^login:/);
    await click('signed-in');
    expect(await screen.findByText('shell:a@b.co:status')).toBeInTheDocument();
    await click('lock-changed');
    expect(lock.status).toHaveBeenCalledTimes(2);
    await click('forget');
    expect(core.forgetSecretKey).toHaveBeenCalled();
    await click('signout');
    expect(signOut).toHaveBeenCalledWith(s);
    expect(await screen.findByText(/^login:a@b.co/)).toBeInTheDocument();
  });

  it('locks when Rust says so, then unlocks or signs out', async () => {
    vi.mocked(resumeSession).mockResolvedValue(s);
    render(<App />);
    await screen.findByText(/^shell:/);
    act(() => {
      h.onLocked?.('idle');
    });
    expect(await screen.findByText('locked:idle')).toBeInTheDocument();
    await click('unlock');
    expect(await screen.findByText(/^shell:/)).toBeInTheDocument();
    act(() => {
      h.onLocked?.('sleep');
    });
    await screen.findByText('locked:sleep');
    await click('lock-signout');
    expect(await screen.findByText(/^login:a@b.co/)).toBeInTheDocument();
  });

  it('ignores lock events when not unlocked', async () => {
    render(<App />);
    await screen.findByText(/^login:/);
    act(() => {
      h.onLocked?.('manual');
    });
    expect(screen.queryByText(/^locked:/)).toBeNull();
  });

  it('walks through sign-up to the Emergency Kit and back to sign-in with the key', async () => {
    render(<App />);
    await screen.findByText(/^login:/);
    await click('create');
    await screen.findByText('signup-email');
    await click('signin');
    await click('create');
    await click('sent');
    expect(await screen.findByText('signup-code:n@b.co')).toBeInTheDocument();
    await click('back');
    await click('sent');
    await click('verified');
    expect(await screen.findByText('signup-password:n@b.co:tok')).toBeInTheDocument();
    await click('created');
    expect(await screen.findByText('kit-done n@b.co')).toBeInTheDocument();
    await click(/kit-done/);
    expect(await screen.findByText('login:n@b.co:Z1-KEY:forgotten')).toBeInTheDocument();
  });

  it('walks through password recovery', async () => {
    render(<App />);
    await screen.findByText(/^login:/);
    await click('forgot');
    expect(await screen.findByText('recover-email:x@b.co')).toBeInTheDocument();
    await click('back');
    await screen.findByText(/^login:/);
    await click('forgot-empty');
    expect(await screen.findByText('recover-email:none')).toBeInTheDocument();
    await click('sent');
    expect(await screen.findByText('recover-codes:x@b.co')).toBeInTheDocument();
    await click('back');
    expect(core.recoverCancel).toHaveBeenCalledTimes(1);
    await screen.findByText(/^login:/);
    await click('forgot');
    await click('sent');
    await click('verified');
    await screen.findByText('recover-password');
    await click('back');
    expect(core.recoverCancel).toHaveBeenCalledTimes(2);
    await screen.findByText(/^login:/);
    await click('forgot');
    await click('sent');
    await click('verified');
    await click('recovered');
    expect(await screen.findByText('kits:a@b.co:R1')).toBeInTheDocument();
    await click('kits-done');
    expect(await screen.findByText(/^shell:/)).toBeInTheDocument();
  });
});
