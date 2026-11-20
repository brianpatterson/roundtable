// The support module's public interface (ADR-0023): the shell imports from here, never from the
// files behind it. "Report a problem" (ADR-0038), shown signed out and signed in.
export { ReportProblem, type ReportProblemProps } from './ReportProblem';
