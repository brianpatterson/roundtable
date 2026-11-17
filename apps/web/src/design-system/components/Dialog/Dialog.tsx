import { AlertDialog } from '@base-ui/react/alert-dialog';
import type { ReactNode } from 'react';
import styles from './Dialog.module.css';

export interface DialogProps {
  /** Controlled: the caller decides when it opens, and closes it from `onOpenChange`. */
  readonly open: boolean;
  /** Called with `false` on Escape. The caller's own buttons close it the same way. */
  readonly onOpenChange: (open: boolean) => void;
  /** Names the dialog for screen readers (`aria-labelledby`). Phrase it as the question. */
  readonly title: string;
  /** What will happen, read out with the title (`aria-describedby`). */
  readonly description: ReactNode;
  /** Anything else the user needs to see before answering, such as an `Alert`. */
  readonly children?: ReactNode;
  /** The answers, as `Button`s: the lesser one (Cancel) first, the confirming one last. */
  readonly actions: ReactNode;
}

/**
 * Material's basic dialog, as an alert dialog: it asks for a decision before anything else
 * happens, so clicking outside doesn't dismiss it. Base UI moves focus in, keeps it there while
 * open, and returns it to what had focus (the button that opened it) when it closes.
 */
export function Dialog({ open, onOpenChange, title, description, children, actions }: DialogProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className={styles.backdrop} />
        <AlertDialog.Popup className={styles.popup}>
          <AlertDialog.Title className={styles.title}>{title}</AlertDialog.Title>
          <AlertDialog.Description className={styles.description}>
            {description}
          </AlertDialog.Description>
          {children}
          <div className={styles.actions}>{actions}</div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
