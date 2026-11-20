import { Alert, Button, ThemeSelect } from '../design-system';
import { ApplicationsPage } from '../modules/applications';
import { AuthGate } from '../modules/identity';
import { ReportProblem } from '../modules/support';
import styles from './App.module.css';

// The shell (ADR-0023): composes the modules and owns the layout around them. Modules never
// import each other or the shell; what one needs from another arrives here as props.
export function App() {
  return (
    <AuthGate
      signedOut={
        <footer className={styles.footer}>
          <ReportProblem />
        </footer>
      }
    >
      {({ userName, userEmail, signOut, signOutError }) => (
        <>
          <main className={styles.main}>
            <header className={styles.header}>
              <h1>Roundtable</h1>
              <div className={styles.actions}>
                <span>{userName}</span>
                <ThemeSelect />
                <Button variant="text" onClick={signOut}>
                  Sign out
                </Button>
              </div>
            </header>
            {signOutError && <Alert tone="error">{signOutError}</Alert>}
            <ApplicationsPage />
          </main>
          <footer className={styles.footer}>
            <ReportProblem defaultReplyEmail={userEmail} />
          </footer>
        </>
      )}
    </AuthGate>
  );
}
