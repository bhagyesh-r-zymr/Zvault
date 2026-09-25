import { CRYPTO_VERSION } from '@zvault/shared';
import { useCallback, useEffect, useState } from 'react';
import { resumeSession, signOut, type Session, type VerifiedRecovery } from './auth.js';
import { core, type RememberedAccount } from './core.js';
import { EmergencyKitStep } from './EmergencyKitStep.js';
import { lock, useActivityReporter, type LockReason, type LockStatus } from './lock.js';
import { LockScreen } from './LockScreen.js';
import { Login } from './screens/Login.js';
import { RecoverCodes, RecoveredKits, RecoverEmail, RecoverPassword } from './screens/Recover.js';
import { SignupCode, SignupEmail, SignupPassword } from './screens/Signup.js';
import { AppShell } from './shell/AppShell.js';
import { UpdateBanner } from './updates/UpdateBanner.js';

type Screen =
  | { name: 'starting' }
  | { name: 'login'; email?: string; secretKey?: string }
  | { name: 'signup-email' }
  | { name: 'signup-code'; email: string }
  | { name: 'signup-password'; email: string; signupToken: string }
  | { name: 'emergency-kit'; email: string; secretKey: string }
  | { name: 'recover-email'; email?: string }
  | { name: 'recover-codes'; email: string }
  | { name: 'recover-password'; verified: VerifiedRecovery }
  | { name: 'recovered'; session: Session; recoveryCode: string }
  | { name: 'unlocked'; session: Session }
  | { name: 'locked'; session: Session; reason: LockReason; status: LockStatus };

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'starting' });
  const [coreError, setCoreError] = useState<string | null>(null);
  const [lockStatus, setLockStatus] = useState<LockStatus | null>(null);
  const [remembered, setRemembered] = useState<RememberedAccount | null>(null);

  // The account whose Secret Key this Mac remembers: sign-in greets it by
  // name and asks only for the master password. Re-read after each change.
  const refreshRemembered = useCallback(() => {
    core.rememberedAccount().then(
      (account) => {
        setRemembered(account);
        if (account) {
          setScreen((prev) =>
            prev.name === 'login' && !prev.email ? { name: 'login', email: account.email } : prev,
          );
        }
      },
      () => setRemembered(null),
    );
  }, []);

  // With "Stay unlocked" on, open straight into the vault; otherwise sign in.
  useEffect(() => {
    void resumeSession().then((session) => {
      setScreen(session ? { name: 'unlocked', session } : { name: 'login' });
      refreshRemembered();
    });
  }, [refreshRemembered]);

  useEffect(() => {
    core.info().then(
      (info) => {
        if (info.cryptoVersion !== CRYPTO_VERSION) {
          setCoreError('The app and its crypto core are out of sync. Reinstall Zvault.');
        }
      },
      (e: unknown) => setCoreError(`Rust core unavailable: ${String(e)}`),
    );
  }, []);

  // Rust locks on idle, sleep and screen lock and has already wiped the keys
  // by the time this fires; drop to the lock screen.
  useEffect(() => {
    const unlisten = lock.onLocked((reason) => {
      void lock
        .status()
        .then((status) =>
          setScreen((prev) =>
            prev.name === 'unlocked'
              ? { name: 'locked', session: prev.session, reason, status }
              : prev,
          ),
        );
    });
    return () => {
      unlisten.then((stop) => stop()).catch(() => undefined);
    };
  }, []);

  const unlocked = screen.name === 'unlocked';
  useActivityReporter(unlocked);

  const refreshLockStatus = useCallback(() => {
    lock.status().then(setLockStatus, (e: unknown) => setCoreError(String(e)));
  }, []);
  useEffect(() => {
    if (unlocked) refreshLockStatus();
  }, [unlocked, refreshLockStatus]);

  // Every unlock refreshes what "Stay unlocked" keeps for the next launch.
  const liveSession = screen.name === 'unlocked' ? screen.session : null;
  const stayUnlocked = lockStatus?.settings.stayUnlocked ?? false;
  useEffect(() => {
    if (liveSession && stayUnlocked) {
      lock.saveForRestart(liveSession.token, liveSession.expiresAt).catch(() => undefined);
    }
  }, [liveSession, stayUnlocked]);

  return (
    <>
      {coreError && (
        <p role="alert" className="alert core-banner">
          {coreError}
        </p>
      )}
      <UpdateBanner />
      {(() => {
        switch (screen.name) {
          case 'starting':
            return null;
          case 'login':
            return (
              <Login
                // Remount when the remembered email arrives after launch.
                key={screen.email ?? ''}
                {...(screen.email ? { email: screen.email } : {})}
                {...(screen.secretKey ? { secretKey: screen.secretKey } : {})}
                remembered={remembered}
                onSignedIn={(session) => {
                  refreshRemembered();
                  setScreen({ name: 'unlocked', session });
                }}
                onCreateAccount={() => setScreen({ name: 'signup-email' })}
                onForgotPassword={(email) =>
                  setScreen({ name: 'recover-email', ...(email ? { email } : {}) })
                }
              />
            );
          case 'recover-email':
            return (
              <RecoverEmail
                {...(screen.email ? { email: screen.email } : {})}
                onSent={(email) => setScreen({ name: 'recover-codes', email })}
                onBack={() => setScreen({ name: 'login' })}
              />
            );
          case 'recover-codes':
            return (
              <RecoverCodes
                email={screen.email}
                onVerified={(verified) => setScreen({ name: 'recover-password', verified })}
                onBack={() => {
                  void core.recoverCancel();
                  setScreen({ name: 'login' });
                }}
              />
            );
          case 'recover-password':
            return (
              <RecoverPassword
                verified={screen.verified}
                onRecovered={({ session, recoveryCode }) => {
                  refreshRemembered();
                  setScreen({ name: 'recovered', session, recoveryCode });
                }}
                onBack={() => {
                  void core.recoverCancel();
                  setScreen({ name: 'login' });
                }}
              />
            );
          case 'recovered':
            return (
              <RecoveredKits
                email={screen.session.email}
                recoveryCode={screen.recoveryCode}
                onDone={() => setScreen({ name: 'unlocked', session: screen.session })}
              />
            );
          case 'signup-email':
            return (
              <SignupEmail
                onSent={(email) => setScreen({ name: 'signup-code', email })}
                onSignIn={() => setScreen({ name: 'login' })}
              />
            );
          case 'signup-code':
            return (
              <SignupCode
                email={screen.email}
                onVerified={(signupToken) =>
                  setScreen({ name: 'signup-password', email: screen.email, signupToken })
                }
                onBack={() => setScreen({ name: 'signup-email' })}
              />
            );
          case 'signup-password':
            return (
              <SignupPassword
                email={screen.email}
                signupToken={screen.signupToken}
                onCreated={(secretKey) =>
                  setScreen({ name: 'emergency-kit', email: screen.email, secretKey })
                }
              />
            );
          case 'emergency-kit':
            return (
              <EmergencyKitStep
                email={screen.email}
                onDone={() =>
                  setScreen({ name: 'login', email: screen.email, secretKey: screen.secretKey })
                }
              />
            );
          case 'locked':
            return (
              <LockScreen
                email={screen.session.email}
                status={screen.status}
                reason={screen.reason}
                onUnlocked={() => setScreen({ name: 'unlocked', session: screen.session })}
                onSignOut={() => {
                  void signOut(screen.session).then(() =>
                    setScreen({ name: 'login', email: screen.session.email }),
                  );
                }}
              />
            );
          case 'unlocked':
            return (
              <AppShell
                session={screen.session}
                lockStatus={lockStatus}
                onLockChanged={refreshLockStatus}
                remembered={remembered}
                onForgetSecretKey={() => core.forgetSecretKey().then(refreshRemembered)}
                onSignOut={() => {
                  void signOut(screen.session).then(() =>
                    setScreen({ name: 'login', email: screen.session.email }),
                  );
                }}
              />
            );
        }
      })()}
    </>
  );
}
