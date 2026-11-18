import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { authClient } from './auth-client';
import { ResetPasswordPage } from './ResetPasswordPage';
import { onSessionEnded } from './session-ended';
import { SignInPage } from './SignInPage';

/** What the signed-in part of the app gets from identity. */
export interface SignedIn {
  readonly userName: string;
  readonly signOut: () => Promise<void>;
  /** Why the last sign-out didn't happen (the user is still signed in), or null. */
  readonly signOutError: string | null;
}

const SIGN_OUT_FAILED = "Couldn't sign out. Check your connection and try again.";

/**
 * A session the app no longer shows as signed in. Better Auth may still hold it until its re-check
 * answers, so it's compared by id: a new sign-in is a different session. `expired`: the API
 * stopped accepting it (`sessionEnded()`), rather than the user signing out.
 */
interface EndedSession {
  readonly id: string;
  readonly expired: boolean;
}

/**
 * Shows the sign-in and password-reset pages until there's a session, then renders `children`
 * with the signed-in user. The shell decides what that is, so identity never imports the shell.
 * When the API stops accepting the session (`sessionEnded()`), it goes back to sign-in.
 */
export function AuthGate({ children }: { children: (signedIn: SignedIn) => ReactNode }) {
  const queryClient = useQueryClient();
  const session = authClient.useSession();
  const { refetch } = session;
  // The client re-checks the session after sign-in/sign-up calls. Showing "Loading…" for those
  // re-checks would unmount the sign-in page and lose its state (like "check your email").
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [ended, setEnded] = useState<EndedSession>();
  // The session a sign-out request is ending. Set from a click, which React renders (and
  // re-subscribes the listener for) before any request's answer can call `sessionEnded()`.
  const [signingOut, setSigningOut] = useState<string>();
  const [signOutFailed, setSignOutFailed] = useState(false);
  const sessionId = session.data?.session.id;

  useEffect(
    () =>
      onSessionEnded(() => {
        // No session, one already ended, or one the user is signing out of: nothing more to do.
        if (sessionId === undefined) return;

        if (sessionId === ended?.id || sessionId === signingOut) return;

        setEnded({ id: sessionId, expired: true });
        // An earlier failed sign-out no longer applies to the next session.
        setSignOutFailed(false);
        // Before the signed-in view unmounts, so none of its queries refetch into another 401.
        queryClient.clear();
      }),
    [sessionId, ended, signingOut, queryClient],
  );

  // Once per expired session, however many requests failed: Better Auth then forgets it too.
  useEffect(() => {
    if (ended?.expired) void refetch();
  }, [ended, refetch]);

  if (!session.isPending && !loadedOnce) setLoadedOnce(true);

  // Signed in again: the old session, and the notice about it, no longer apply.
  if (ended && sessionId !== undefined && sessionId !== ended.id) setEnded(undefined);

  if (window.location.pathname === '/reset-password') return <ResetPasswordPage />;

  if (session.isPending && !loadedOnce) return <main>Loading…</main>;

  if (!session.data || session.data.session.id === ended?.id) {
    return <SignInPage sessionEnded={ended?.expired ?? false} />;
  }

  const signedInId = session.data.session.id;

  async function signOut() {
    // Before the request goes out: a query that answers 401 meanwhile isn't an expiry.
    setSigningOut(signedInId);
    setSignOutFailed(false);

    const succeeded = await authClient.signOut().then(
      (result) => !result.error,
      () => false,
    );

    // The server may still accept the session: keep showing it as signed in, never fail open.
    if (!succeeded) {
      setSigningOut(undefined);
      setSignOutFailed(true);

      return;
    }

    setEnded({ id: signedInId, expired: false });
    queryClient.clear();
  }

  return children({
    userName: session.data.user.name,
    signOut,
    signOutError: signOutFailed ? SIGN_OUT_FAILED : null,
  });
}
