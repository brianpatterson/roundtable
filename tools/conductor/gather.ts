// Reads what every open Work item's state depends on from GitHub, through the `fetch` it's given,
// and returns GitHub's answers trimmed to the fields `observe` reads. The only code here that reads
// GitHub (README.md); it decides nothing and reads no clock.

import { type Json, type JsonObject, Missing, Read, parseJson } from './json.ts';
import { CONDUCTOR, DISPATCH, MINOR_FINDING, STATE, isMarked } from './markers.ts';
import {
  type GatheredOpenWorkItem,
  type GatheredWorkItem,
  type OpenWorkItem,
  type UnreadableWorkItem,
  type WorkItemRef,
  closerCommit,
  isExecutorRun,
} from './raw.ts';
import { parseRunName } from './run-name.ts';

export interface GitHub {
  readonly fetch: typeof fetch;
  readonly token: string;
  /** `owner/name`. */
  readonly repository: string;
}

export interface GatherOptions {
  /** Executor runs created since then are read: 24 hours before the `at` it's gathered for. */
  readonly since: Date;
  /** Executor runs created after then aren't read: when a recorded Work item closed; `null` for now. */
  readonly until: Date | null;
  /**
   * Whose checks and statuses to read: the head's, enough for now, or every commit's, which a
   * history fixture needs to observe a past head.
   */
  readonly commits: 'head' | 'all';
}

/**
 * The version of what `gather` reads and how it trims it. A history fixture states the one it was
 * recorded with, and the history test refuses another: raise it whenever a change here would make
 * a fixture recorded before it read differently.
 */
export const GATHER_VERSION = 1;

/** Labels that make an open issue a Work item. */
export const TICKET_LABELS = ['ready', 'building', 'needs-info', 'needs-human'];

/** Labels that make an open pull request a Work item, besides Dependabot's own. */
export const PULL_REQUEST_LABELS = ['factory', 'autofix'];

const API = 'https://api.github.com';

/** A read GitHub failed or refused. */
class Refused extends Error {
  override readonly name = 'Refused';
}

interface Page {
  readonly body: Read;
  readonly next: string | null;
}

// `<https://api.github.com/...&page=2>; rel="next", <...>; rel="last"`
function nextLink(header: string | null): string | null {
  if (header === null) return null;

  for (const part of header.split(',')) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part);

    if (match?.[1] !== undefined) return match[1];
  }

  return null;
}

async function call(github: GitHub, url: string, init: RequestInit, what: string): Promise<Page> {
  let response: Response;

  try {
    response = await github.fetch(url, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${github.token}`,
        'User-Agent': 'roundtable-conductor',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch (error) {
    throw new Refused(
      `GitHub couldn't be reached for ${what}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) throw new Refused(`GitHub answered ${response.status} to ${what}`);

  const body = new Read(parseJson(await response.text(), what), what);

  return { body, next: nextLink(response.headers.get('link')) };
}

/** Every item of a REST list, following its pages. `key` names the list in an object answer. */
async function rest(github: GitHub, path: string, key: string | null): Promise<Read[]> {
  const items: Read[] = [];
  let url: string | null = `${API}${path}`;

  while (url !== null) {
    const page: Page = await call(github, url, { method: 'GET' }, `GET ${path}`);

    items.push(...(key === null ? page.body : page.body.field(key)).items());
    url = page.next;
  }

  return items;
}

/**
 * Every workflow run a filtered list holds, following its pages. GitHub lists at most 1,000 runs
 * for a filtered query, newest first, so a list its `total_count` says is longer is refused rather
 * than read without its oldest runs.
 */
async function workflowRuns(github: GitHub, path: string): Promise<Read[]> {
  const runs: Read[] = [];
  let total = 0;
  let url: string | null = `${API}${path}`;

  while (url !== null) {
    const page: Page = await call(github, url, { method: 'GET' }, `GET ${path}`);

    total = page.body.field('total_count').number();
    runs.push(...page.body.field('workflow_runs').items());
    url = page.next;
  }

  if (runs.length < total) {
    throw new Refused(
      `GitHub listed ${runs.length} of the ${total} runs for GET ${path}: it lists at most 1,000, so the oldest are missing`,
    );
  }

  return runs;
}

/** One REST answer. */
async function restOne(github: GitHub, path: string): Promise<Read> {
  return (await call(github, `${API}${path}`, { method: 'GET' }, `GET ${path}`)).body;
}

type Variables = Readonly<Record<string, string | number | null>>;

async function graphql(
  github: GitHub,
  query: string,
  variables: Variables,
  what: string,
): Promise<Read> {
  const [owner = '', name = ''] = github.repository.split('/');

  const page = await call(
    github,
    `${API}/graphql`,
    { method: 'POST', body: JSON.stringify({ query, variables: { owner, name, ...variables } }) },
    what,
  );

  const errors = page.body.field('errors');

  if (!errors.absent()) {
    const first = errors.items()[0];

    throw new Refused(
      `GitHub refused ${what}: ${first?.field('message').optionalText() ?? 'no reason given'}`,
    );
  }

  return page.body.field('data').field('repository');
}

/**
 * Every node of one GraphQL connection, following its pages. The query takes `$cursor`, and `path`
 * leads from the repository to the connection.
 */
async function connection(
  github: GitHub,
  query: string,
  variables: Variables,
  path: readonly string[],
): Promise<Json[]> {
  const nodes: Json[] = [];
  let cursor: string | null = null;

  for (;;) {
    let page = await graphql(
      github,
      query,
      { ...variables, cursor },
      `the ${path.join('.')} of #${variables.number ?? ''}`,
    );

    for (const key of path) page = page.field(key);

    nodes.push(
      ...page
        .field('nodes')
        .items()
        .map((node) => node.json()),
    );

    if (!page.field('pageInfo').field('hasNextPage').boolean()) return nodes;

    cursor = page.field('pageInfo').field('endCursor').text();
  }
}

const PAGE = 'pageInfo { hasNextPage endCursor }';

const LIST_ISSUES = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, labels: ${JSON.stringify(TICKET_LABELS)}, first: 100, after: $cursor) { ${PAGE} nodes { number } }
  }
}`;

const LIST_PULL_REQUESTS = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, after: $cursor) {
      ${PAGE}
      nodes {
        number
        author { login }
        labels(first: 100) { nodes { name } }
        closingIssuesReferences(first: 10) { nodes { number } }
      }
    }
  }
}`;

const ISSUE = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) { number createdAt author { login } } }
}`;

const ISSUE_TIMELINE = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      timelineItems(itemTypes: [LABELED_EVENT, UNLABELED_EVENT, RENAMED_TITLE_EVENT, CLOSED_EVENT, REOPENED_EVENT], first: 100, after: $cursor) {
        ${PAGE}
        nodes {
          __typename
          ... on LabeledEvent { createdAt label { name } actor { login } }
          ... on UnlabeledEvent { createdAt label { name } actor { login } }
          ... on RenamedTitleEvent { createdAt actor { login } }
          ... on ClosedEvent { createdAt closer { __typename ... on PullRequest { merged mergeCommit { oid } } ... on Commit { oid } } }
          ... on ReopenedEvent { createdAt }
        }
      }
    }
  }
}`;

const ISSUE_EDITS = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) { userContentEdits(first: 100, after: $cursor) { ${PAGE} nodes { editedAt editor { login } } } }
  }
}`;

const ISSUE_BLOCKERS = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) { blockedBy(first: 100, after: $cursor) { ${PAGE} nodes { number } } }
  }
}`;

const PULL_REQUEST = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { number createdAt author { login } headRefOid mergeable mergeCommit { oid } }
  }
}`;

const PULL_REQUEST_COMMITS = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(first: 100, after: $cursor) {
        ${PAGE}
        nodes { commit { oid committedDate authors(first: 10) { nodes { user { login } } } } }
      }
    }
  }
}`;

const PULL_REQUEST_TIMELINE = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      timelineItems(itemTypes: [LABELED_EVENT, UNLABELED_EVENT, CLOSED_EVENT, REOPENED_EVENT, MERGED_EVENT], first: 100, after: $cursor) {
        ${PAGE}
        nodes {
          __typename
          ... on LabeledEvent { createdAt label { name } actor { login } }
          ... on UnlabeledEvent { createdAt label { name } actor { login } }
          ... on ClosedEvent { createdAt }
          ... on ReopenedEvent { createdAt }
          ... on MergedEvent { createdAt commit { oid } }
        }
      }
    }
  }
}`;

/** Every open Work item: its Ticket, its pull request, or both. */
export async function listWorkItems(github: GitHub): Promise<WorkItemRef[]> {
  const tickets = (await connection(github, LIST_ISSUES, {}, ['issues'])).map((node) =>
    new Read(node, 'issue').field('number').number(),
  );

  const pullRequests: { number: number; closes: number[] }[] = [];

  for (const node of await connection(github, LIST_PULL_REQUESTS, {}, ['pullRequests'])) {
    const pr = new Read(node, 'pull request');

    const labels = pr
      .field('labels')
      .field('nodes')
      .items()
      .map((label) => label.field('name').text());

    const author = pr.field('author').field('login').optionalText() ?? '';

    if (
      !labels.some((label) => PULL_REQUEST_LABELS.includes(label)) &&
      !author.startsWith('dependabot')
    ) {
      continue;
    }

    pullRequests.push({
      number: pr.field('number').number(),
      closes: pr
        .field('closingIssuesReferences')
        .field('nodes')
        .items()
        .map((issue) => issue.field('number').number()),
    });
  }

  // A pull request that closes a listed issue belongs to that issue's Work item: the latest one,
  // when more than one does.
  const items = new Map<number, WorkItemRef>(
    tickets.map((number) => [number, { number, ticket: number, pullRequest: null }]),
  );

  for (const pr of pullRequests.sort((a, b) => a.number - b.number)) {
    const ticket = pr.closes.find((number) => tickets.includes(number));

    if (ticket === undefined) {
      items.set(pr.number, { number: pr.number, ticket: null, pullRequest: pr.number });
    } else {
      items.set(ticket, { number: ticket, ticket, pullRequest: pr.number });
    }
  }

  return [...items.values()].sort((a, b) => a.number - b.number);
}

/** An issue with its timeline: the Ticket's, or a Blocker's. */
async function readIssue(github: GitHub, number: number): Promise<JsonObject> {
  const issue = (await graphql(github, ISSUE, { number }, `issue #${number}`)).field('issue');
  const timeline = await connection(github, ISSUE_TIMELINE, { number }, ['issue', 'timelineItems']);

  return {
    number: issue.field('number').number(),
    createdAt: issue.field('createdAt').text(),
    author: { login: issue.field('author').field('login').optionalText() },
    timeline,
  };
}

/**
 * The lines `observe` reads of a marker comment: its markers, heading and footer, and each minor
 * finding's mark without its text.
 */
function trimBody(body: string): string {
  return body
    .split('\n')
    .flatMap((line) => {
      if (MINOR_FINDING.test(line)) return ['1. **minor**'];

      return ['<!-- factory-', '### ', '<sub>', 'Re-reviewed '].some((start) =>
        line.startsWith(start),
      )
        ? [line]
        : [];
    })
    .join('\n');
}

/** The commit that closed an issue the last time, and when: what a deploy must include. */
function closingCommit(issue: Read): { commit: string; at: number } | null {
  const closes = issue
    .field('timeline')
    .items()
    .filter((event) => event.field('__typename').text() === 'ClosedEvent');

  const last = closes.at(-1);

  if (last === undefined) return null;

  const closer = last.field('closer');

  if (closer.absent()) return null;

  const commit = closerCommit(closer);

  return commit === null ? null : { commit, at: last.field('createdAt').time() };
}

/** What a run of `gather` reads once, for every Work item. */
interface Shared {
  readonly main: Json[];
  readonly deploys: Json[];
  readonly runs: Json[];
  /** The same Executor runs as `act` reads them: `{display_title, id, conclusion, created_at}`. */
  readonly executorRuns: Json[];
  /** Compare results already read, by `commit...deploy`. */
  readonly compared: Map<string, string>;
}

/** How many deploys after a merge are compared with it, oldest first, before giving up. */
const DEPLOYS_COMPARED = 5;

/** Which deploys include each commit: compared oldest first from its merge, until one does. */
async function readInclusions(
  github: GitHub,
  shared: Shared,
  commits: readonly { commit: string; at: number }[],
): Promise<Json[]> {
  const deploys = shared.deploys
    .map((deploy) => new Read(deploy, 'deploy'))
    .map((deploy) => ({
      sha: deploy.field('head_sha').text(),
      at: deploy.field('updated_at').time(),
    }))
    .sort((a, b) => a.at - b.at);

  const inclusions: Json[] = [];

  for (const { commit, at } of commits) {
    for (const deploy of deploys.filter((d) => d.at >= at).slice(0, DEPLOYS_COMPARED)) {
      const key = `${commit}...${deploy.sha}`;
      let status = shared.compared.get(key);

      if (status === undefined) {
        status = (await restOne(github, `/repos/${github.repository}/compare/${key}`))
          .field('status')
          .text();
        shared.compared.set(key, status);
      }

      inclusions.push({ commit, deploy: deploy.sha, status });

      if (status === 'ahead' || status === 'identical') break;
    }
  }

  return inclusions;
}

async function readWorkItem(
  github: GitHub,
  ref: WorkItemRef,
  options: GatherOptions,
  shared: Shared,
): Promise<OpenWorkItem> {
  const repo = github.repository;
  let ticket: Json = null;
  const blockers: Json[] = [];
  const merges: { commit: string; at: number }[] = [];
  // The comments on the issue or pull request `act` comments on, for the surface.
  let targetComments: Read[] = [];

  if (ref.ticket !== null) {
    const number = ref.ticket;
    const issue = await readIssue(github, number);
    const edits = await connection(github, ISSUE_EDITS, { number }, ['issue', 'userContentEdits']);

    const ticketComments = await rest(
      github,
      `/repos/${repo}/issues/${number}/comments?per_page=100`,
      null,
    );

    targetComments = ticketComments;

    // Only the dispatcher's own comments, which say which Tickets were in flight when one waited:
    // anyone can comment on an issue, and a User report's Ticket keeps none of its text.
    const comments = ticketComments
      .filter(
        (comment) =>
          comment.field('user').field('login').optionalText() === 'github-actions[bot]' &&
          comment.field('body').text().startsWith(DISPATCH),
      )
      .map((comment) => ({
        user: { login: 'github-actions[bot]' },
        created_at: comment.field('created_at').text(),
        body: comment.field('body').text().split('\n').slice(0, 2).join('\n'),
      }));

    ticket = { ...issue, edits, comments };

    const closing = closingCommit(new Read(issue, 'ticket'));

    if (closing !== null) merges.push(closing);

    for (const node of await connection(github, ISSUE_BLOCKERS, { number }, [
      'issue',
      'blockedBy',
    ])) {
      const blocker = await readIssue(github, new Read(node, 'blocker').field('number').number());
      const blockerClosing = closingCommit(new Read(blocker, 'blocker'));

      blockers.push(blocker);

      if (blockerClosing !== null) merges.push(blockerClosing);
    }
  }

  let pullRequest: Json = null;
  const checks: Json[] = [];
  const statuses: Json[] = [];
  let comments: Json[] = [];
  let mentions: Json[] = [];
  let headChecks: Read[] = [];

  if (ref.pullRequest !== null) {
    const number = ref.pullRequest;

    const pr = (await graphql(github, PULL_REQUEST, { number }, `pull request #${number}`)).field(
      'pullRequest',
    );

    const commits = await connection(github, PULL_REQUEST_COMMITS, { number }, [
      'pullRequest',
      'commits',
    ]);

    const timeline = await connection(github, PULL_REQUEST_TIMELINE, { number }, [
      'pullRequest',
      'timelineItems',
    ]);

    const head = pr.field('headRefOid').text();

    pullRequest = {
      number: pr.field('number').number(),
      createdAt: pr.field('createdAt').text(),
      author: { login: pr.field('author').field('login').optionalText() },
      mergeable: pr.field('mergeable').optionalText(),
      mergeCommit: pr.field('mergeCommit').absent()
        ? null
        : { oid: pr.field('mergeCommit').field('oid').text() },
      commits,
      timeline,
    };

    const merged = timeline
      .map((event) => new Read(event, 'pull request event'))
      .find((event) => event.field('__typename').text() === 'MergedEvent');

    if (merged !== undefined) {
      merges.push({
        commit: merged.field('commit').field('oid').text(),
        at: merged.field('createdAt').time(),
      });
    }

    const shas =
      options.commits === 'head'
        ? [head]
        : commits.map((node) => new Read(node, 'commit').field('commit').field('oid').text());

    for (const sha of shas) {
      const runs = await rest(
        github,
        `/repos/${repo}/commits/${sha}/check-runs?per_page=100`,
        'check_runs',
      );

      if (sha === head) headChecks = runs;

      checks.push({
        sha,
        checkRuns: runs.map((run) => ({
          name: run.field('name').text(),
          status: run.field('status').text(),
          conclusion: run.field('conclusion').optionalText(),
          started_at: run.field('started_at').optionalText(),
          completed_at: run.field('completed_at').optionalText(),
        })),
      });

      const commitStatuses = await rest(
        github,
        `/repos/${repo}/commits/${sha}/statuses?per_page=100`,
        null,
      );

      statuses.push({
        sha,
        statuses: commitStatuses.map((status) => ({
          context: status.field('context').text(),
          state: status.field('state').text(),
          description: status.field('description').optionalText(),
          created_at: status.field('created_at').text(),
        })),
      });
    }

    const all = await rest(github, `/repos/${repo}/issues/${number}/comments?per_page=100`, null);
    const owner = repo.split('/')[0] ?? '';

    if (ref.ticket === null) targetComments = all;

    // The Owner's `@claude`, when it was asked: not what it says, which the mention Executor reads.
    mentions = all
      .filter((comment) => comment.field('user').field('login').optionalText() === owner)
      .filter((comment) => comment.field('body').text().includes('@claude'))
      .map((comment) => ({
        user: { login: owner },
        created_at: comment.field('created_at').text(),
      }));

    // Only the workflow's own marker comments: anyone can comment on a public pull request.
    comments = all
      .filter(
        (comment) => comment.field('user').field('login').optionalText() === 'github-actions[bot]',
      )
      .filter((comment) => isMarked(comment.field('body').text()))
      .map((comment) => ({
        user: { login: 'github-actions[bot]' },
        created_at: comment.field('created_at').text(),
        updated_at: comment.field('updated_at').text(),
        body: trimBody(comment.field('body').text()),
      }));
  }

  return {
    number: ref.number,
    owner: repo.split('/')[0] ?? '',
    ticket,
    blockers,
    pullRequest,
    checks,
    statuses,
    comments,
    mentions,
    main: shared.main,
    deploys: shared.deploys,
    inclusions: await readInclusions(github, shared, merges),
    runs: shared.runs,
    surface: surfaceOf(ref, targetComments, headChecks, shared),
  };
}

/** The Actions run a check run belongs to, from its `details_url`; `null` for another app's check. */
function actionsRun(check: Read): number | null {
  const run = /\/actions\/runs\/([0-9]+)/.exec(
    check.field('details_url').optionalText() ?? '',
  )?.[1];

  return run === undefined ? null : Number(run);
}

/** What `act` reads before it writes (`OpenWorkItem`), from answers already read. */
function surfaceOf(
  ref: WorkItemRef,
  targetComments: readonly Read[],
  headChecks: readonly Read[],
  shared: Shared,
): Json {
  // Only the workflow's own: anyone can comment, and a stranger's look-alike isn't ours to edit.
  const own = targetComments.filter(
    (comment) => comment.field('user').field('login').optionalText() === 'github-actions[bot]',
  );

  const stateComment = own.find((comment) => comment.field('body').text().startsWith(STATE));

  const said = own
    .flatMap((comment) => {
      const body = comment.field('body').text();

      return body.startsWith(CONDUCTOR) ? [{ at: comment.field('created_at').time(), body }] : [];
    })
    .sort((a, b) => a.at - b.at)
    .at(-1);

  return {
    target: ref.ticket ?? ref.pullRequest ?? ref.number,
    stateComment:
      stateComment === undefined
        ? null
        : {
            id: stateComment.field('id').number(),
            body: stateComment.field('body').text(),
          },
    said: said?.body ?? null,
    checkRuns: headChecks.map((check) => ({
      name: check.field('name').text(),
      started_at: check.field('started_at').optionalText(),
      run: actionsRun(check),
    })),
    runs: shared.executorRuns.filter((run) => {
      const read = new Read(run, 'run');
      const name = parseRunName(read.field('display_title').text());

      return name !== null && name.item === ref.number && !read.field('conclusion').absent();
    }),
  };
}

async function readShared(github: GitHub, options: GatherOptions): Promise<Shared> {
  const repo = github.repository;

  // The latest 100 successful deploys: a change merged before the oldest counts as Deployed from then.
  const deploys = (
    await restOne(
      github,
      `/repos/${repo}/actions/workflows/deploy.yml/runs?status=success&per_page=100`,
    )
  )
    .field('workflow_runs')
    .items()
    .map((run) => ({
      head_sha: run.field('head_sha').text(),
      updated_at: run.field('updated_at').text(),
    }));

  const created = encodeURIComponent(
    options.until === null
      ? `>=${options.since.toISOString()}`
      : `${options.since.toISOString()}..${options.until.toISOString()}`,
  );

  const executor = (
    await workflowRuns(
      github,
      `/repos/${repo}/actions/runs?event=workflow_dispatch&created=${created}&per_page=100`,
    )
  ).filter(
    (run) =>
      isExecutorRun(run) && parseRunName(run.field('display_title').optionalText() ?? '') !== null,
  );

  const executorRuns = executor.map((run) => ({
    display_title: run.field('display_title').text(),
    id: run.field('id').number(),
    conclusion: run.field('conclusion').optionalText(),
    created_at: run.field('created_at').text(),
  }));

  const runs = executor.map((run) => ({
    display_title: run.field('display_title').text(),
    event: run.field('event').text(),
    status: run.field('status').text(),
    created_at: run.field('created_at').text(),
    run_started_at: run.field('run_started_at').optionalText(),
    updated_at: run.field('updated_at').text(),
  }));

  // The latest 100 commits of main: conflict Attempts count per commit of it.
  const main = (await restOne(github, `/repos/${repo}/commits?sha=main&per_page=100`))
    .items()
    .map((commit) => ({
      sha: commit.field('sha').text(),
      committed_at: commit.field('commit').field('committer').field('date').text(),
    }));

  return { main, deploys, runs, executorRuns, compared: new Map() };
}

/** Why a Work item couldn't be read: GitHub's answer, or what it lacked. */
const reason = (error: Error): string =>
  error instanceof Refused || error instanceof Missing
    ? error.message
    : `reading it failed: ${error.message}`;

const unreadable = (number: number, why: string): UnreadableWorkItem => ({
  number,
  unreadable: why,
});

const DAY = 24 * 60 * 60 * 1000;

const RESOLVE = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue { number createdAt closedAt closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number } } }
      ... on PullRequest { number createdAt closedAt closingIssuesReferences(first: 10) { nodes { number } } }
    }
  }
}`;

/**
 * Reads one Work item, open or closed, for a history fixture: the Ticket `number` with the latest
 * pull request that closes it, or the pull request `number` that closes no issue. Every commit's
 * checks and statuses are read, and the Executor runs from 24 hours before it was opened until it
 * closed.
 */
export async function gatherWorkItem(github: GitHub, number: number): Promise<GatheredWorkItem> {
  try {
    const found = (
      await graphql(github, RESOLVE, { number }, `issue or pull request #${number}`)
    ).field('issueOrPullRequest');

    const numbers = (connection: string): number[] =>
      found
        .field(connection)
        .field('nodes')
        .items()
        .map((node) => node.field('number').number());

    let ref: WorkItemRef;

    if (found.field('__typename').text() === 'Issue') {
      const pullRequests = numbers('closedByPullRequestsReferences');

      ref = {
        number,
        ticket: number,
        pullRequest: pullRequests.length === 0 ? null : Math.max(...pullRequests),
      };
    } else {
      const closes = numbers('closingIssuesReferences');

      if (closes.length > 0) {
        throw new Refused(
          `#${number} is the pull request of ${closes.map((n) => `#${n}`).join(', ')}: record its Ticket instead`,
        );
      }

      ref = { number, ticket: null, pullRequest: number };
    }

    // The runs of its life only: a list from then until now grows by every sweep's run.
    const closed = found.field('closedAt').optionalTime();

    const options: GatherOptions = {
      since: new Date(found.field('createdAt').time() - DAY),
      until: closed === null ? null : new Date(closed),
      commits: 'all',
    };

    // A fixture holds what `observe` reads, not the surface `act` reads now.
    const { surface: _surface, ...raw } = await readWorkItem(
      github,
      ref,
      options,
      await readShared(github, options),
    );

    return raw;
  } catch (error) {
    return unreadable(number, error instanceof Error ? reason(error) : String(error));
  }
}

/**
 * Reads every open Work item. One GitHub fails or refuses to answer about is returned as
 * unreadable, with the reason, and the rest are still read. Fails only when the list itself, or
 * what every Work item shares (deploys, Executor runs), can't be read.
 */
export async function gather(
  github: GitHub,
  options: GatherOptions,
): Promise<GatheredOpenWorkItem[]> {
  const refs = await listWorkItems(github);
  const shared = await readShared(github, options);
  const gathered: GatheredOpenWorkItem[] = [];

  for (const ref of refs) {
    try {
      gathered.push(await readWorkItem(github, ref, options, shared));
    } catch (error) {
      gathered.push(unreadable(ref.number, error instanceof Error ? reason(error) : String(error)));
    }
  }

  return gathered;
}
