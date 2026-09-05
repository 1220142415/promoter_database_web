'use client';

import Link from 'next/link';
import { FormEvent, ReactNode, useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import styles from './auth.module.css';

type AuthUser = { id: string; email: string; emailConfirmed: boolean };
type AuthPayload = {
  authenticated?: boolean;
  codeSent?: boolean;
  user?: AuthUser;
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
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const data = new FormData(event.currentTarget);
    try {
      const { response, payload } = await authRequest({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: codeSent ? 'verify-code' : 'send-code',
          email: data.get('email'),
          ...(codeSent ? { token: data.get('token') } : {}),
        }),
      });
      if (payload.authenticated) {
        window.location.assign(nextPath);
        return;
      }
      if (response.status === 202 && payload.codeSent) {
        setCodeSent(true);
        setMessage('We sent a 6-digit verification code to your email.');
        return;
      }
      setMessage(payload.error?.message || 'Authentication failed.');
    } catch {
      setMessage('Authentication service could not be reached.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.page}>
      <section className={styles.panel} aria-labelledby="prediction-auth-heading">
        <p className="portal-kicker">Prediction access</p>
        <h1 id="prediction-auth-heading">Sign in to predict</h1>
        <p>Enter your email and we will send a verification code. Your first successful verification creates the account automatically.</p>
        <form onSubmit={submit} className={styles.form}>
          <label><span>Email</span><input name="email" type="email" autoComplete="email" maxLength={254} value={email} readOnly={codeSent} onChange={(event) => setEmail(event.target.value)} required /></label>
          {codeSent ? <label><span>Verification code</span><input name="token" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required autoFocus /></label> : null}
          {message ? <p className={styles.message} role="status">{message}</p> : null}
          <button className="portal-button portal-button-primary" type="submit" disabled={busy}>
            {busy ? 'Please wait…' : codeSent ? 'Verify and sign in' : 'Send verification code'}
          </button>
          {codeSent ? <button className="portal-text-link" type="button" onClick={() => { setCodeSent(false); setMessage(null); }}>Use a different email</button> : null}
        </form>
        <Link className="portal-text-link" href="/">Return to public portal</Link>
      </section>
    </main>
  );
}

export function PredictionAuthGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSession = useCallback(async () => {
    try {
      const { response, payload } = await authRequest();
      if (response.ok && payload.authenticated && payload.user) {
        setUser(payload.user);
        setError(null);
        return;
      }
      if (response.status === 401) {
        router.replace(`/login?next=${encodeURIComponent(pathname)}`);
        return;
      }
      setError(payload.error?.message || 'Prediction sign-in is unavailable.');
    } catch {
      setError('Prediction sign-in could not be reached.');
    }
  }, [pathname, router]);

  useEffect(() => {
    void loadSession();
    const refresh = window.setInterval(() => void loadSession(), 45 * 60 * 1000);
    return () => window.clearInterval(refresh);
  }, [loadSession]);

  async function logout() {
    await authRequest({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'logout' }),
    }).catch(() => null);
    window.location.assign('/login?next=/predict');
  }

  if (error) {
    return <main className={`${styles.state} portal-shell`}><p role="alert">{error}</p><button className="portal-button portal-button-secondary" type="button" onClick={() => void loadSession()}>Retry</button></main>;
  }
  if (!user) return <main className={`${styles.state} portal-shell`} aria-busy="true">Checking prediction access…</main>;

  return (
    <>
      <div className={styles.sessionBar}>
        <div className="portal-shell">
          <span>Daily allowance: 1 whole-genome scan · short sequences unlimited · resets 00:00 Beijing</span>
          <span>Signed in as <strong>{user.email}</strong></span>
          <button type="button" onClick={logout}>Sign out</button>
        </div>
      </div>
      {children}
    </>
  );
}
