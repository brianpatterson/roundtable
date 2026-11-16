import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PASSWORD_MIN_LENGTH, type AuthProvider } from '@roundtable/contract';
import { Alert, Button, TextField } from '../../design-system';
import { api } from '../../shared/api';
import { authClient } from './auth-client';
import styles from './auth.module.css';

type Mode = 'sign-in' | 'sign-up' | 'forgot';

const providerLabels: Record<AuthProvider, string> = { github: 'GitHub', google: 'Google' };

export function SignInPage() {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Failed redirects from the API land on /?error=…: a bad confirmation link, or a GitHub/Google
  // sign-in that couldn't complete.
  const [error, setError] = useState<string | null>(() =>
    redirectErrorMessage(new URLSearchParams(window.location.search).get('error')),
  );

  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    // Drop ?error=… from the address bar so a reload doesn't show it again.
    if (window.location.search) window.history.replaceState(null, '', window.location.pathname);
  }, []);

  const config = useQuery({ queryKey: ['auth-config'], queryFn: api.authConfig });

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setPending(true);

    const result =
      mode === 'sign-in'
        ? await authClient.signIn.email({ email, password })
        : mode === 'sign-up'
          ? await authClient.signUp.email({ email, password, name, callbackURL: '/' })
          : await authClient.requestPasswordReset({ email, redirectTo: '/reset-password' });

    setPending(false);

    if (result.error) {
      if (result.error.code === 'EMAIL_NOT_VERIFIED') {
        return setNotice(`Confirm your email first: check ${email} (and spam) for the link.`);
      }

      return setError(result.error.message ?? 'Something went wrong');
    }

    if (mode === 'sign-up') {
      setPassword('');
      setNotice(`Check ${email} for a link to finish creating your account.`);
    }

    if (mode === 'forgot') setNotice('If that email has an account, a reset link is on its way.');
  }

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setNotice(null);
  }

  return (
    <main className={styles.page}>
      <h1>Roundtable</h1>
      <h2>
        {mode === 'sign-in'
          ? 'Sign in'
          : mode === 'sign-up'
            ? 'Create an account'
            : 'Reset password'}
      </h2>

      {mode !== 'forgot' && config.data && config.data.providers.length > 0 && (
        <>
          <div className={styles.stack}>
            {config.data.providers.map((provider) => (
              <Button
                key={provider}
                variant="outlined"
                onClick={() =>
                  authClient.signIn.social({ provider, callbackURL: '/', errorCallbackURL: '/' })
                }
              >
                Continue with {providerLabels[provider]}
              </Button>
            ))}
          </div>
          <p className={styles.divider}>or</p>
        </>
      )}

      <form className={styles.stack} onSubmit={onSubmit}>
        {mode === 'sign-up' && (
          <TextField
            label="Name"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        )}
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        {mode !== 'forgot' && (
          <TextField
            label="Password"
            description={
              mode === 'sign-up' ? `At least ${PASSWORD_MIN_LENGTH} characters` : undefined
            }
            type="password"
            autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
            minLength={PASSWORD_MIN_LENGTH}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        )}
        <Button type="submit" disabled={pending}>
          {mode === 'sign-in'
            ? 'Sign in'
            : mode === 'sign-up'
              ? 'Create account'
              : 'Send reset link'}
        </Button>
        {error && <Alert tone="error">{error}</Alert>}
        {notice && <Alert>{notice}</Alert>}
      </form>

      <p className={styles.links}>
        {mode === 'sign-in' ? (
          <>
            <Button variant="text" onClick={() => switchMode('sign-up')}>
              Create an account
            </Button>
            <Button variant="text" onClick={() => switchMode('forgot')}>
              Forgot password?
            </Button>
          </>
        ) : (
          <Button variant="text" onClick={() => switchMode('sign-in')}>
            Back to sign in
          </Button>
        )}
      </p>
    </main>
  );
}

function redirectErrorMessage(code: string | null): string | null {
  if (!code) return null;

  if (code === 'INVALID_TOKEN' || code === 'TOKEN_EXPIRED') {
    return 'That confirmation link is invalid or has expired. Sign in to get a new one.';
  }

  if (code === 'account_not_linked') {
    // The email already has an account that either isn't confirmed or wasn't confirmed by the
    // provider, so the two aren't joined automatically (see apps/api/src/modules/identity/better-auth.ts).
    return "That email already has an account here. Sign in with your email and password instead (confirm your email first if you haven't).";
  }

  return "Sign-in didn't complete. Please try again.";
}
