# Factory glossary

The software factory's language: the words its agents, workflows, tickets and ADRs use for how
work gets built. The product's own words are in [`GLOSSARY.md`](../../GLOSSARY.md); a word that
means one thing here and another there is a bug in one of them. Terms marked _(planned)_ are
decided in an ADR but not built yet: until the pull request that builds one removes the mark, the
workflows are what's true.

- **Approval**: the Owner's go-ahead to build a Ticket, given by labeling it `ready`. Only the
  Owner's counts, except on a Mutation ticket, which the nightly run approves itself. Editing the
  Ticket afterwards voids it until the Owner gives it again. Not a Review: the reviewer never
  approves anything.
- **Attempt**: one try by an agent at one kind of repair on a pull request: fixing CI, Rework,
  or resolving a conflict with `main`. Each kind gets two, counted since the Owner last pushed
  (for a conflict, per commit of `main`); after the second comes a Hand-over. A Minor pass isn't
  one. Builds get two as well _(planned, ADR-0075)_.
- **Batch**: the Tickets of one Spec, built one at a time in Blocker order. It closes when its
  last Ticket does, which starts its Retro and the architecture review. _(planned, ADR-0074)_:
  its Tickets merge into a batch branch, and the Batch merges into `main` once, by the Owner.
- **Blocker**: an issue a Ticket waits on. The Ticket starts only once every Blocker's change is
  merged and Deployed.
- **Conductor** _(planned, ADR-0075)_: the one place that decides each Work item's next step,
  from what GitHub shows at that moment, and starts an Executor to take it.
- **Deployed**: a merged change is Deployed once a deploy that includes it has succeeded. Merged
  isn't Deployed: a deploy can fail, or be skipped.
- **Executor** _(planned, ADR-0075)_: a run that takes one step for one Work item (a build, a CI
  fix, a review, a Rework, a conflict resolution, an answer to `@claude`) without deciding
  whether to. It refuses a step that would do harm on its own, whatever the Conductor decided.
- **Factory**: the agents and workflows that build Approved Tickets into pull requests, review
  and repair them, and learn from each Batch. The Owner merges.
- **Hand-over**: the factory giving a Work item to the Owner, saying why (`needs-human`). Nothing
  in the factory acts on it until the Owner hands it back by removing the label.
- **Minor pass**: Rework's one try at a Review whose findings are all minor. It isn't an
  Attempt, and pushing nothing just leaves the findings to the Owner.
- **Mutation ticket**: a tests-only Ticket the nightly mutation run files and approves itself,
  for one file whose mutants no test kills. Built after the Owner's Tickets.
- **Needs info**: a Ticket the implementer can't build as written, with its questions to the
  Owner. The Owner answers by editing the Ticket and giving Approval again.
- **Owner**: the repository's one human. Approves, answers, merges, and takes Hand-overs.
- **Owner path** _(planned, ADR-0074)_: a file whose change never merges without the Owner: what
  configures a gate, the supply chain, authentication, what runs in production, and the
  Conductor itself.
- **Retro**: the review of how the factory built a Batch, from the trail its agents left, filed
  as one issue of fixes to the factory's environment.
- **Review**: the reviewer's verdict on a pull request's head commit: **ready** (no blocking
  findings) or **changes**. A pull request whose head has a ready Review is **reviewed**. Not an
  Approval.
- **Rework**: the implementer answering a changes Review on one of the factory's pull requests.
- **Spec**: the issue that holds a roadmap step's design. Its sub-issues are the Tickets of its
  Batch.
- **Ticket**: an issue the factory can build: a feature or a bug, written with the issue forms'
  headings, built into one pull request that closes it.
- **User report**: a Ticket filed from a user's report in the app. The report itself stays
  private: the factory reads it only while building, and never quotes it.
- **Work item** _(planned, ADR-0075)_: a Ticket and its pull request, followed together from
  Approval to Deployed. A pull request with no Ticket (Dependabot's, the Owner's) is a Work item
  too, and so is a Batch once ADR-0074 is built.
