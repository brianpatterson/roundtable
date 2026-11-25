# 0070. Make the Agenda the home page, served by one endpoint that cuts off by the user's day

- **Status:** Accepted
- **Date:** 2026-11-24

## Context

Phase 4 step 3 (`docs/roadmap.md`) adds the Agenda: the user's upcoming Rounds across all their
Applications, the answer to "what should I prepare for next?" (`GLOSSARY.md`). Today every Round
is read through its Application (`GET /api/applications/:id/rounds`), and the web app has two
routes: `/` for the Applications table and `/applications/$applicationId`.

Three things need deciding, and each is hard to undo once bookmarks, links and later features
(Prep in step 4, the ICS feed in step 7) depend on it:

- **Where the Agenda lives.** Whether it takes the home page, which moves the Applications table.
- **How it gets its data.** No endpoint returns Rounds across Applications.
- **What "upcoming" means.** It depends on the day, and the day depends on the user's time zone,
  which the server doesn't know (the same problem ADR-0061 solved for inference).

## Options considered

For where it lives:

1. **A new `/agenda` route, with `/` staying the Applications table.** Pros: no link moves. Cons:
   the page a user opens most is a click away from the one they land on.
2. **The Agenda at `/`, the Applications table at `/applications`.** Pros: you land on what's next,
   which is why you open the app during a search. Cons: links and browser tests that go to `/` for
   the table move.
3. **An Agenda section above the Applications table on `/`.** Pros: one page. Cons: the table
   pushes the Agenda's empty state and long lists into one scroll; neither gets its own page.

For the data:

1. **`GET /api/agenda?timeZone=…` in the applications module,** which owns Rounds: one query for
   the user's Rounds joined to their open Applications, filtered and sorted on the server with the
   contract's `roundDay` and `inRoundOrder`, each Round returned with its Application's id, company
   and job title. Pros: one request; the cut-off and order are tested on the server; step 4 adds
   prep progress to it and step 7's feed can reuse the query. Cons: a query parameter that isn't
   about the data, as in ADR-0061.
2. **The browser composes it** from `GET /api/applications` and each one's Rounds. Pros: no new
   endpoint. Cons: N+1 requests, and the filter lives only in the browser.

For "upcoming": until a scheduled Round's start, until its end (start plus duration), or until the
end of its day in the user's time zone.

## Decision

The Agenda is the home page (`/`), and the Applications table moves to `/applications`. The shell
header gets navigation between the two, marking the current page.

`GET /api/agenda` (option 1 for data) behind `Authorization`, taking an optional `timeZone` (an
IANA name checked like ADR-0061's; UTC without one). It returns Rounds of the user's Applications
that aren't rejected, withdrawn or accepted, where the Round:

- is scheduled on today or later, or is a take-home due today or later, in that time zone (a Round
  stays on the Agenda until the end of its day, even after it starts), or
- has no date yet; these come after every dated Round.

Dated Rounds are in date order across Applications (Round order, ties broken by company); undated
ones in the order they were added. "Time left" is worked out in the browser, which knows the time.

The web page is `AgendaPage`, exported by the applications module, which owns Rounds and their
formatting; no new web module.

## Consequences

- Links to `/` that meant the table ("Back to my applications") move to `/applications`; the
  not-found page goes back to the Agenda.
- A client that sends no time zone gets UTC days, so near midnight a Round can drop off or stay a
  few hours early or late, as with ADR-0061.
- Prep progress isn't on the Agenda yet: step 4 adds it to this endpoint and page when prep tasks
  exist.
- If the Agenda outgrows Rounds (deadlines that aren't Rounds, say), it may become its own module;
  the endpoint's path doesn't name the applications module, so it can move without changing.
