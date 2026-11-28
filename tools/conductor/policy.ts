// Every number the Conductor decides by (ADR-0075): `decide` has none of its own. Changing one is
// changing what the factory does, so each says where it came from.

export interface Policy {
  /** Attempts of each kind before a Hand-over: since the last human push, or per commit of `main`. */
  readonly attempts: {
    readonly ciFix: number;
    readonly rework: number;
    readonly conflict: number;
  };
  /** Rework's Minor passes since the last human push, which aren't Attempts (ADR-0053). */
  readonly minorPasses: number;
  /** Builds of a Ticket that ended without a pull request, since its Approval, before a Hand-over (ADR-0075). */
  readonly builds: number;
  /** Minutes a Ticket may be `building` with no build run seen and no pull request (ADR-0047). */
  readonly staleBuildMinutes: number;
  /** Minutes a merge may go without being Deployed before a Hand-over (ADR-0075). */
  readonly undeployedMinutes: number;
  /** The sweeper's thresholds (ADR-0040), in minutes. */
  readonly stale: {
    /** From the head's commit to the first check on it. */
    readonly ciStart: number;
    /** A check queued or running. */
    readonly ciRun: number;
    /** From a CI failure the CI fixer has answered to a Hand-over, when nothing changed. */
    readonly ciFix: number;
    /** From CI passing, when the reviewer has run and left no Review of the head. */
    readonly review: number;
    /** From a `changes` Review Rework has answered, when nothing changed. */
    readonly rework: number;
  };
  /** Reruns of a check that ended neither passing nor failing (cancelled, timed out) before a Hand-over. */
  readonly reruns: number;
  /**
   * The dispatch budget, in Executor starts in any 24 hours (ADR-0076). The Executors' guards
   * enforce it; `decide` only stops asking at the same numbers.
   */
  readonly budget: {
    readonly item: number;
    readonly all: number;
  };
}

export const policy: Policy = {
  attempts: { ciFix: 2, rework: 2, conflict: 2 },
  minorPasses: 1,
  builds: 2,
  staleBuildMinutes: 90,
  undeployedMinutes: 3 * 60,
  stale: { ciStart: 30, ciRun: 90, ciFix: 120, review: 60, rework: 120 },
  reruns: 1,
  budget: { item: 20, all: 60 },
};
