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
}

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
  const sessionId = session.data?.session.id;

  useEffect(
    () =>
      onSessionEnded(() => {
        // No session, or one already ended (the user signed out): nothing more to do.
        if (sessionId === undefined || sessionId === ended?.id) return;

        setEnded({ id: sessionId, expired: true });
        // Before the signed-in view unmounts, so none of its queries refetch into another 401.
        queryClient.clear();
      }),
    [sessionId, ended, queryClient],
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
    await authClient.signOut();
    // Hidden at once, before a query can refetch into a 401 and report this as an expiry.
    setEnded({ id: signedInId, expired: false });
    queryClient.clear();
  }

  return children({ userName: session.data.user.name, signOut });
}
