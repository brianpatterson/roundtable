// The factory's marker comments: the first line of each comment a workflow leaves as evidence of a
// step. Named once here, with the exact strings the scripts in `.github/factory/` write
// (`markers.test.ts` checks each still appears there).

/** The CI fixer's comment after each Attempt (`attempt.sh`, ADR-0028). */
export const CI_FIX = '<!-- factory-ci-fix -->';

/** Rework's comment after each Attempt (`attempt.sh`, ADR-0037). */
export const REWORK = '<!-- factory-rework -->';

/** The second line of Rework's comment on its Minor pass, which isn't an Attempt (ADR-0053). */
export const REWORK_MINOR = '<!-- factory-rework-minor -->';

/** The conflict resolver's comment after each Attempt, naming the commit of `main` (ADR-0058). */
export const CONFLICT = '<!-- factory-conflict -->';

/** The reviewer's one comment, edited in place on every re-review (`post-review.sh`, ADR-0046). */
export const REVIEW = '<!-- factory-review -->';

/** The short comment a re-review that asks for changes posts (`post-review.sh`, ADR-0046). */
export const REVIEW_CHANGES = '<!-- factory-review-changes -->';

/** The dispatcher's comments on a Ticket (`dispatch.sh`, ADR-0047). */
export const DISPATCH = '<!-- factory-dispatch -->';

export const MARKERS = [CI_FIX, REWORK, REWORK_MINOR, CONFLICT, REVIEW, REVIEW_CHANGES, DISPATCH];

// The Conductor's own comments (`act.ts`), which no script in `.github/factory/` writes, so they
// aren't in `MARKERS`, and `observe` reads neither: they report, and decide nothing.

/** The one comment on each Ticket (or pull request without one) with its state, reason and time (ADR-0075). */
export const STATE = '<!-- factory-state -->';

/** The Conductor's comment when it hands a Work item over or withdraws an Approval, with the reason. */
export const CONDUCTOR = '<!-- factory-conductor -->';

/** A minor finding's line in the reviewer's comment, as `post-review.sh` counts them (`1. **minor**:`). */
export const MINOR_FINDING = /^\s*([0-9]+\.|[-*]) \*\*minor\*\*/;

/** Whether a comment body begins with one of the markers. */
export const isMarked = (body: string): boolean =>
  MARKERS.some((marker) => body.startsWith(marker));
