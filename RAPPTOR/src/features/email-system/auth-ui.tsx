'use client';

import Link from 'next/link';
import { FormEvent, ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import styles from './auth.module.css';

type AuthUser = { id: string; email: string; emailConfirmed: boolean };
type AuthPayload = {
  authenticated?: boolean;
  codeSent?: boolean;
  retryAfter?: number;
  expiresIn?: number;
  user?: AuthUser;
  quota?: { usedBases: number; totalBases: number; resetAt: string };
  error?: { message?: string };
};

async function authRequest(init?: RequestInit): Promise<{ response: Response; payload: AuthPayload }> {
  const response = await fetch('/api/prediction-auth', { ...init, cache: 'no-store' });
  const payload = await response.json().catch(() => ({})) as AuthPayload;
  return { response, payload };
}

export function PredictionAuthForm({ nextPath = '/predict' }: { nextPath?: string }) {
  const [email, setEmail] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [token, setToken] = useState('');
  const [resendAt, setResendAt] = useState(0);
  const [expiresAt, setExpiresAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const pending = useRef(false);

  useEffect(() => {
    let active = true;
    void authRequest().then(({ payload }) => {
      if (active && payload.authenticated) window.location.assign(nextPath);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [nextPath]);

  useEffect(() => {
    if (!codeSent && !resendAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [codeSent, resendAt]);

  const resendSeconds = Math.max(0, Math.ceil((resendAt - now) / 1000));
  const expirySeconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));

  async function authenticate(action: 'send-code' | 'verify-code') {
    if (pending.current) return;
    if (action === 'send-code' && Date.now() < resendAt) return;
    pending.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const { response, payload } = await authRequest({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          email,
          ...(action === 'verify-code' ? { token } : {}),
        }),
      });
      if (payload.authenticated) {
        window.location.assign(nextPath);
        return;
      }
      if (response.status === 202 && payload.codeSent) {
        const sentAt = Date.now();
        setNow(sentAt);
        setResendAt(sentAt + (payload.retryAfter || 60) * 1000);
        setExpiresAt(sentAt + (payload.expiresIn || 600) * 1000);
        setToken('');
        setCodeSent(true);
        setMessage('We sent a 6-digit code. Check your inbox and spam folder, and use the latest email.');
        return;
      }
      if (response.status === 429 || (action === 'send-code' && response.status >= 500)) {
        const retryAfter = Number(response.headers.get('Retry-After')) || 60;
        const receivedAt = Date.now();
        setNow(receivedAt);
        setResendAt(receivedAt + retryAfter * 1000);
      }
      setMessage(payload.error?.message || 'Authentication failed.');
    } catch {
      setMessage('Authentication service could not be reached.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await authenticate(codeSent ? 'verify-code' : 'send-code');
  }

  return (
    <main className={styles.page}>
      <section className={styles.panel} aria-labelledby="prediction-auth-heading">
        <p className="portal-kicker">Prediction access</p>
        <h1 id="prediction-auth-heading">Sign in to predict</h1>
        <p>Enter your email and we will send a verification code. Your first successful verification creates the account automatically.</p>
        <form onSubmit={submit} className={styles.form}>
          <label><span>Email</span><input name="email" type="email" autoComplete="email" maxLength={254} value={email} readOnly={codeSent || busy} onChange={(event) => setEmail(event.target.value)} required /></label>
          {codeSent ? <label><span>Verification code</span><input name="token" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={token} onChange={(event) => setToken(event.target.value)} required autoFocus /></label> : null}
          {codeSent ? <p className={styles.message}>{expirySeconds
            ? `Code expires in ${Math.floor(expirySeconds / 60)}:${String(expirySeconds % 60).padStart(2, '0')}. Only the latest code can be used.`
            : 'This code has expired. Request a new code below.'}</p> : null}
          {message ? <p className={styles.message} role="status">{message}</p> : null}
          <button className="portal-button portal-button-primary" type="submit" disabled={busy || (!codeSent && resendSeconds > 0) || (codeSent && expirySeconds === 0)}>
            {busy ? 'Please wait…' : codeSent ? 'Verify and sign in' : resendSeconds ? `Wait ${resendSeconds}s` : 'Send verification code'}
          </button>
          {codeSent ? <>
            <button className="portal-text-link" type="button" disabled={busy || resendSeconds > 0} onClick={() => void authenticate('send-code')}>
              {resendSeconds ? `Resend code in ${resendSeconds}s` : 'Resend verification code'}
            </button>
            <button className="portal-text-link" type="button" disabled={busy} onClick={() => { setCodeSent(false); setToken(''); setExpiresAt(0); setMessage(null); }}>Use a different email</button>
          </> : null}
        </form>
        <Link className="portal-text-link" href="/">Return to public portal</Link>
      </section>
    </main>
  );
}

export function PredictionAuthGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [user, setUser] = useState<AuthUser | null>();
  const [quota, setQuota] = useState<AuthPayload['quota']>();
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const logoutPending = useRef(false);
  const sessionVersion = useRef(0);

  const loadSession = useCallback(async () => {
    if (logoutPending.current) return;
    const version = sessionVersion.current;
    try {
      const { response, payload } = await authRequest();
      if (version !== sessionVersion.current) return;
      if (response.ok && payload.authenticated && payload.user) {
        setUser(payload.user);
        setQuota(payload.quota);
        setError(null);
        setSignOutFailed(false);
        return;
      }
      if (response.status === 401) {
        setUser(null);
        setQuota(undefined);
        setError(null);
        setSignOutFailed(false);
        return;
      }
      setError(payload.error?.message || 'Prediction sign-in is unavailable.');
    } catch {
      if (version === sessionVersion.current) setError('Prediction sign-in could not be reached.');
    }
  }, []);

  useEffect(() => {
    void loadSession();
    const refresh = window.setInterval(() => void loadSession(), 45 * 60 * 1000);
    window.addEventListener('rapptor:prediction-submitted', loadSession);
    return () => {
      window.clearInterval(refresh);
      window.removeEventListener('rapptor:prediction-submitted', loadSession);
    };
  }, [loadSession]);

  async function logout() {
    if (logoutPending.current) return;
    logoutPending.current = true;
    sessionVersion.current += 1;
    setSigningOut(true);
    try {
      const { response, payload } = await authRequest({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'logout' }),
      });
      if (!response.ok || payload.authenticated !== false) {
        setSignOutFailed(true);
        setError('Sign-out was not confirmed. You may still be signed in; retry before leaving this device.');
        return;
      }
      setUser(null);
      setQuota(undefined);
      setError(null);
      setSignOutFailed(false);
    } catch {
      setSignOutFailed(true);
      setError('Sign-out was not confirmed. You may still be signed in; retry before leaving this device.');
    } finally {
      logoutPending.current = false;
      setSigningOut(false);
    }
  }

  return (
    <>
      <div className={styles.sessionBar}>
        <div className="portal-shell">
          <div className={styles.quota}>
            <span>{quota
              ? `Daily prediction bases: ${quota.usedBases.toLocaleString()} / ${quota.totalBases.toLocaleString()} bp`
              : 'Daily prediction allowance is measured in bases'} · resets 08:00 Beijing</span>
            {quota ? <progress value={quota.usedBases} max={quota.totalBases} aria-label="Daily prediction base usage" /> : null}
          </div>
          {error ? <span role="alert">{error} <button type="button" disabled={signingOut} onClick={() => signOutFailed ? void logout() : void loadSession()}>Retry</button></span>
            : user ? <><span>Signed in as <strong>{user.email}</strong></span><button type="button" disabled={signingOut} onClick={logout}>{signingOut ? 'Signing out…' : 'Sign out'}</button></>
              : user === null ? <Link className="portal-text-link" href={`/login?next=${encodeURIComponent(pathname)}`}>Sign in to submit</Link>
                : <span>Checking sign-in…</span>}
        </div>
      </div>
      {children}
    </>
  );
}
