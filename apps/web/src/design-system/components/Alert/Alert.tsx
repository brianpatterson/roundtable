import type { ReactNode } from 'react';
import styles from './Alert.module.css';

export type AlertTone = 'error' | 'info';

export interface AlertProps {
  /** `error` is announced at once (role="alert"); `info` politely (role="status"). */
  readonly tone?: AlertTone;
  readonly children: ReactNode;
}

/** A message about the current view: a failed request, a "check your email" notice. */
export function Alert({ tone = 'info', children }: AlertProps) {
  return (
    <p role={tone === 'error' ? 'alert' : 'status'} className={`${styles.alert} ${styles[tone]}`}>
      {children}
    </p>
  );
}
