// The email module's public interface (ADR-0023): other modules and server.ts import from here,
// never from the files behind it. Sends auth emails within the sending limits (ADR-0018). The App
// provides EmailLive once; its limits and its transport (Resend or the log) are chosen inside.
export { EmailLive } from './email.js';

export { Mailer } from './mailer.js';

export { emailSends } from './schema.js';

export { EmailTransport, type Email, type SendEmail } from './transport.js';
