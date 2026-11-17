// "The API says this user is signed out": the one way the rest of the app tells identity that the
// session has ended. The shell calls `sessionEnded()` for every Unauthorized answer, from outside
// React, so this is a tiny event source that `AuthGate` listens to.
const listeners = new Set<() => void>();

/**
 * Tells identity the API no longer accepts the session (it expired, or was revoked). Identity
 * clears the cached server state, re-checks the session and shows the sign-in page with a notice.
 * Calling it again before that has happened does nothing more.
 */
export function sessionEnded() {
  for (const listener of listeners) listener();
}

/** Calls `listener` on every `sessionEnded()`; returns the unsubscribe function. */
export function onSessionEnded(listener: () => void) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}
