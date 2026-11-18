// The identity module's public interface (ADR-0023): the shell imports from here, never from the
// files behind it. Sign-in, sign-up, password reset, and the session gate around the app, which
// also owns session expiry: the shell reports every Unauthorized answer through `sessionEnded`.
export { AuthGate, type SignedIn } from './AuthGate';

export { sessionEnded } from './session-ended';
