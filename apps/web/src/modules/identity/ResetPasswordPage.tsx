import { useState, type FormEvent } from 'react';
import { PASSWORD_MIN_LENGTH } from '@roundtable/contract';
import { Alert, Button, TextField } from '../../design-system';
import { authClient } from './auth-client';
import styles from './auth.module.css';

export function ResetPasswordPage() {
  const token = new URLSearchParams(window.location.search).get('token');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();

    // Stryker disable next-line ConditionalExpression: the form, and so this handler, only renders when there is a token
    if (!token) return;
    const result = await authClient.resetPassword({ newPassword: password, token });

    if (result.error) return setError(result.error.message ?? 'Something went wrong');
    setDone(true);
  }

  return (
    <main className={styles.page}>
      <h1>Roundtable</h1>
      <h2>Choose a new password</h2>
      {!token ? (
        <Alert tone="error">This reset link is invalid or has expired.</Alert>
      ) : done ? (
        <Alert>
          Password updated. <a href="/">Sign in</a>
        </Alert>
      ) : (
        <form className={styles.stack} onSubmit={onSubmit}>
          <TextField
            label="New password"
            description={`At least ${PASSWORD_MIN_LENGTH} characters`}
            type="password"
            autoComplete="new-password"
            minLength={PASSWORD_MIN_LENGTH}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <Button type="submit">Update password</Button>
          {error && <Alert tone="error">{error}</Alert>}
        </form>
      )}
    </main>
  );
}
