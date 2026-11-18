import { Toast } from '@base-ui/react/toast';
import type { ReactNode } from 'react';
import { Button } from '../Button/Button';
import styles from './Snackbar.module.css';

/** How long a snackbar stays before it goes on its own; hovering or focusing it pauses this. */
export const SNACKBAR_TIMEOUT_MS = 6000;

/** A snackbar for an error: announced at once (an alert). */
const errorToast = (message: string) => ({ description: message, priority: 'high' as const });

/** Brands a `Snackbars`. Only types carry it, and only `createSnackbars` adds it. */
declare const fromCreateSnackbars: unique symbol;

/**
 * Snackbars that code outside React can show a message in, such as the shell's query cache. Give
 * the same object to `SnackbarProvider`; `useSnackbar` inside it reaches the same snackbars.
 * Only `createSnackbars` makes one: another object with a `show` method doesn't type-check, since
 * the provider couldn't find the snackbars behind it and its messages would never appear.
 */
export interface Snackbars {
  readonly show: (message: string) => void;
  readonly [fromCreateSnackbars]: true;
}

/**
 * Base UI's toast manager behind each `Snackbars`. It stays in here, so a caller can only `show` a
 * message (as an error, like `useSnackbar`), never add a toast with options of its own.
 */
const managers = new WeakMap<Snackbars, ReturnType<typeof Toast.createToastManager>>();

export function createSnackbars(): Snackbars {
  const manager = Toast.createToastManager();

  // SAFETY: the brand exists only in types, and this is the one place that adds it, right before
  // registering the object's manager below, so every Snackbars has a manager.
  const snackbars = Object.freeze({
    show: (message: string) => {
      manager.add(errorToast(message));
    },
  }) as Snackbars;

  managers.set(snackbars, manager);

  return snackbars;
}

/**
 * Where snackbars appear. Mount it once, around the whole app (the shell does), so a message
 * outlives the view that showed it. Pass `snackbars` to show messages from outside React too.
 */
export function SnackbarProvider({
  snackbars,
  children,
}: {
  readonly snackbars?: Snackbars;
  readonly children: ReactNode;
}) {
  return (
    <Toast.Provider
      timeout={SNACKBAR_TIMEOUT_MS}
      toastManager={snackbars && managers.get(snackbars)}
    >
      {children}
      <Toast.Portal>
        <Toast.Viewport className={styles.viewport}>
          <SnackbarList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

function SnackbarList() {
  const { toasts, close } = Toast.useToastManager();

  return toasts.map((toast) => (
    <Toast.Root key={toast.id} toast={toast} className={styles.snackbar}>
      <Toast.Description className={styles.message} />
      <Button variant="text" onClick={() => close(toast.id)}>
        Dismiss
      </Button>
    </Toast.Root>
  ));
}

/**
 * Returns a function that shows a message in a snackbar: Material's short note at the bottom of the
 * screen that something didn't work, which doesn't move the page. It's announced to screen readers
 * at once (an alert), and each call shows its own message, so none is lost.
 */
export function useSnackbar() {
  const { add } = Toast.useToastManager();

  return (message: string) => add(errorToast(message));
}
