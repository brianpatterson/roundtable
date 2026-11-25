import { Alert, Button, Link, ThemeSelect } from '../design-system';
import { AuthGate } from '../modules/identity';
import { ReportProblem } from '../modules/support';
import styles from './App.module.css';
import { Routes } from './router';

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
            <Routes
              header={
                <>
                  <header className={styles.header}>
                    <h1>Roundtable</h1>
                    <div className={styles.actions}>
                      <span>{userName}</span>
                      <ThemeSelect />
                      <Button variant="text" onClick={signOut}>
                        Sign out
                      </Button>
                    </div>
                    {/* Each page is marked (aria-current) only on its own address. */}
                    <nav className={styles.nav} aria-label="Pages">
                      <Link to="/" activeOptions={{ exact: true }}>
                        Agenda
                      </Link>
                      <Link to="/applications" activeOptions={{ exact: true }}>
                        Applications
                      </Link>
                    </nav>
                  </header>
                  {signOutError && <Alert tone="error">{signOutError}</Alert>}
                </>
              }
            />
          </main>
          <footer className={styles.footer}>
            <ReportProblem defaultReplyEmail={userEmail} />
          </footer>
        </>
      )}
    </AuthGate>
  );
}
