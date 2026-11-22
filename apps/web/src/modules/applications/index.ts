// The applications module's public interface (ADR-0023): the shell imports from here, never from
// the files behind it. One root component per page the shell routes to (ADR-0049), so the module
// could become a microfrontend unchanged.
export { ApplicationsPage } from './ApplicationsPage';

export { ApplicationPage } from './ApplicationPage';
