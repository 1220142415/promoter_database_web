'use client';

import { useEffect, useId, useRef } from 'react';
import type { PredictionCapabilities } from '../types';
import styles from './prediction.module.css';

declare global {
  interface Window {
    turnstile?: {
      render: (element: HTMLElement, options: Record<string, unknown>) => string;
      remove: (widgetId: string) => void;
    };
  }
}

export default function TurnstileField({ capabilities, onToken }: { capabilities: PredictionCapabilities; onToken: (token: string) => void }) {
  const id = useId().replaceAll(':', '');
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (capabilities.mode === 'demo') {
      onToken('demo-turnstile-bypass');
      return;
    }
    if (!capabilities.turnstileSiteKey || !container.current) return;

    let cancelled = false;
    let widgetId: string | null = null;
    const render = () => {
      if (cancelled || !container.current || !window.turnstile || widgetId) return;
      widgetId = window.turnstile.render(container.current, {
        sitekey: capabilities.turnstileSiteKey,
        callback: (token: string) => onToken(token),
        'expired-callback': () => onToken(''),
        'error-callback': () => onToken(''),
        theme: 'light',
      });
    };
    const existing = document.querySelector<HTMLScriptElement>('script[data-rapptor-turnstile]');
    if (existing) {
      if (window.turnstile) render();
      else existing.addEventListener('load', render, { once: true });
    } else {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.dataset.rapptorTurnstile = 'true';
      script.addEventListener('load', render, { once: true });
      document.head.appendChild(script);
    }
    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [capabilities.mode, capabilities.turnstileSiteKey, onToken]);

  if (capabilities.mode === 'demo') {
    return (
      <div className={styles.localOnly} data-testid="demo-turnstile">
        <span aria-hidden="true">✓</span>
        <div><strong>Demo request protection</strong><small>Demo only; no sequence is uploaded.</small></div>
      </div>
    );
  }

  return <div id={`turnstile-${id}`} ref={container} className={styles.turnstile} aria-label="Turnstile verification" />;
}
