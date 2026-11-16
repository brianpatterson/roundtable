// The identity module's public interface (ADR-0023): other modules and server.ts import from here,
// never from the files behind it. Owns sign-in (Better Auth), the session check behind every
// protected group, and the auth tables. The App provides IdentityLive once.
export { IdentityLive } from './identity.js';

export { accounts, sessions, users, verifications } from './schema.js';
