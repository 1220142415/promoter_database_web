'use client';

import { useId, useState } from 'react';
import styles from './help-tip.module.css';

export default function HelpTip({ label, text }: { label: string; text: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return <span className={styles.root}>
    <button type="button" className={styles.button} aria-label={`Help: ${label}`} aria-describedby={open ? id : undefined} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onKeyDown={(event) => { if (event.key === 'Escape') { setOpen(false); event.currentTarget.blur(); } }}>?</button>
    {open ? <span id={id} role="tooltip" className={styles.tooltip}>{text}</span> : null}
  </span>;
}
