# Glossary

Roundtable's domain language: the words the code, tickets and reviews use for things in the
product. The weekly architecture review proposes entries in its issues (ADR-0031); the pull
request that builds one adds them here.

- **Session expiry**: the moment the API answers `Unauthorized` for a user the web app still
  shows as signed in. Owned by the identity module, which returns the user to sign-in with a
  notice ([ADR-0032](docs/adr/0032-web-identity-owns-session-expiry.md)).
