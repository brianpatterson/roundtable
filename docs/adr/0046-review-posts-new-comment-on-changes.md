# 0046. Post a short new comment when a re-review asks for changes

- **Status:** Accepted
- **Date:** 2026-11-21

## Context

[ADR-0026](0026-software-factory-reviewer.md) has the reviewer post one comment per pull request,
marked `<!-- factory-review -->`, and edit it on every re-review. That keeps the conversation short,
but an edit raises no event anyone outside GitHub's UI can see.

The owner's own pull requests are opened from Claude Code sessions, and the Claude desktop app's
Auto-fix watches those: it wakes the session on CI failures, conflicts and new review comments,
not on edited ones. On 2026-11-21 a re-review of a new commit on PR #119 said "Changes needed"
with six findings, and nothing reacted. The factory's own pull requests don't have this problem:
the Rework workflow reads the review's verdict artifact, not the comment
([ADR-0037](0037-software-factory-rework.md)). Labeling session pull requests `factory` to get
Rework was ruled out: two fixers would race on one branch, and session commits, authored as the
owner, reset Rework's attempt cap.

## Options considered

1. **A new full review comment on every re-review**: each one is an event. But the findings of
   every commit stack up in the conversation, and everything that reads "the review" (the sweeper,
   Rework, the reviewer's own lookup) would have to pick the latest of many.
2. **Keep editing the one review, and post a short new comment when a re-review asks for
   changes**, pointing at the review. One event, no duplicated findings, and readers of the main
   review are unchanged.
3. **A formal "request changes" pull request review**: ADR-0026 decided the reviewer never
   approves or requests changes, and the job's token posts as `github-actions[bot]`, which
   would then block merging.

## Decision

Option 2. When a re-review's verdict is `changes`, `.github/factory/post-review.sh` edits the main
review and posts a new comment marked `<!-- factory-review-changes -->`: "Re-reviewed `<short sha>`:
✋ changes needed. See the factory review", linking it. Every review that posts or edits deletes
the earlier short comments first, so at most one exists, and only under a review that still asks
for changes. A `ready` re-review posts nothing new. The first review is a new comment already and
gets none, and a repeat of the same verdict on the same commit (a `review` label re-run) changes
nothing but the review's text.

The short comments are deleted rather than minimized or kept: they hold nothing but a pointer,
and the review they point to is itself overwritten, so keeping them would be history of nothing.
A stale "changes needed" under a `ready` review would only mislead.

## Consequences

- Auto-fix in a Claude Code session sees a `changes` re-review and wakes. It still acts on the
  main review's findings.
- The marker is distinct and doesn't start with `<!-- factory-review -->`, so the sweeper's verdict
  lookup, Rework's review loader and the reviewer's own "find my comment" never match it. The
  implementer reads `github-actions[bot]` comments on a factory pull request, so it sees the short
  comment too; it adds nothing the review doesn't say.
- Posting moved from inline workflow shell to a script with a test (`test-post-review.sh`, in CI),
  which also pins the main comment's format that `sweep-prs.sh` reads.
- On a factory pull request, Rework already reacts to the verdict; the short comment is noise
  there, one line per `changes` re-review at most. Revisit if Auto-fix learns to watch edits.
