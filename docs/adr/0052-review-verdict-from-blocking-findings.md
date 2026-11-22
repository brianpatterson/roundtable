# 0052. Derive the review's verdict from its blocking findings

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

The reviewer ([ADR-0026](0026-software-factory-reviewer.md)) returned two separate things: a
`verdict` (`ready` or `changes`) and a review whose findings are each marked **blocking** or
**minor**. Nothing tied them together. The verdict alone decides whether Rework runs
([ADR-0037](0037-software-factory-rework.md)), so a review could list a blocker and still say
"ready", and the factory would hand the owner a pull request with a known blocker and no rework.
Or it could ask for changes over minor findings only and spend a rework attempt on them. On PR #144
the reviewer did the right thing (two minor findings, `ready`), but only because the model chose to.

Minor findings on a `ready` review were then left for the owner on factory pull requests. The
owner wants the factory to fix them too, without a loop: each fix is reviewed again, and a
reviewer can usually find something minor to say.

## Options considered

1. **Spell the rule out in `reviewer.md`**: "any blocking finding means `changes`". Cheap, but
   still the model's judgment; nothing checks it.
2. **Keep the verdict, add a blocking count, and fail when they disagree**: catches the mismatch,
   but a failed step posts no review, so the pull request stalls until the sweeper flags it.
3. **Drop the verdict from the reviewer's output; it returns a count of blocking findings, and
   `post-review.sh` derives the verdict**, taking the larger of that count and the findings the
   review marks `**blocking**`. One source of truth, and a miscount in either direction can only
   err towards asking for changes.

## Decision

Option 3. The reviewer's structured output is `{blocking, review}`. `post-review.sh` counts the
numbered or bulleted findings that start with `**blocking**`, takes the larger of that and
`blocking`, posts "Changes needed" when it's above zero and "Ready for you" otherwise, and writes the
verdict as a step output. The Review workflow's verdict record, which Rework reads, uses that
output, not anything the model returned.

The record also carries the number of findings marked `**minor**`. Rework runs, as before, on
`changes`, and its fix covers every finding, minor ones included. It also runs once on a `ready`
review with minor findings: one minor pass per factory pull request (since the owner's last push,
like the attempt count), marked `<!-- factory-rework-minor -->` in its comment and outside the two
attempts. Later minor-only reviews are left for the owner. If the minor pass pushes nothing, the
findings are the owner's, with no `needs-human` label: a `ready` pull request is already the owner's
turn. This amends [ADR-0037](0037-software-factory-rework.md).

## Consequences

- A blocker always starts a rework on a factory pull request, and on the owner's own pull requests
  always posts "Changes needed", which Auto-fix sees ([ADR-0046](0046-review-posts-new-comment-on-changes.md)).
- Minor findings alone never cost one of the two attempts, and the factory fixes the first
  minor-only review's findings itself. The most reworks a factory pull request gets is three: two
  for blockers and the minor pass. A minor pass that introduces a blocker gets the full two attempts.
- Minor findings the reviewer leaves unmarked aren't counted, so they get no minor pass; that only
  leaves them for the owner, as before.
- The findings' format is now a contract: each starts with `**blocking**` or `**minor**`. A
  blocker written in another shape is caught only by the count. `test-post-review.sh` pins both.
- If the reviewer starts overusing **blocking** to force reworks, the remedy is in its instructions
  (what counts as blocking), not in this mechanism.
