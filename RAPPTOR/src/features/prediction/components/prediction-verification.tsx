'use client';

import { useEffect, useRef } from 'react';

export default function PredictionVerification({ siteKey, onToken }: { siteKey: string; onToken: (token: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let widgetId: string | undefined;
    const render = () => {
      if (container.current && window.turnstile && !widgetId) {
        widgetId = window.turnstile.render(container.current, { sitekey: siteKey, callback: onToken, 'expired-callback': () => onToken('') });
      }
    };
    const existing = document.querySelector<HTMLScriptElement>('script[data-rapptor-turnstile]');
    const script = existing || document.createElement('script');
    if (!existing) {
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true; script.defer = true; script.dataset.rapptorTurnstile = 'true';
      document.head.appendChild(script);
    }
    script.addEventListener('load', render); render();
    return () => { script.removeEventListener('load', render); if (widgetId) window.turnstile?.remove?.(widgetId); };
  }, [siteKey, onToken]);
  return <div ref={container} aria-label="Human verification" />;
}
