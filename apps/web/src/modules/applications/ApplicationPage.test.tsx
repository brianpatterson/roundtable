import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestRouter, TestRouterProvider } from '../../shared/testing/router';
import { ApplicationPage } from './ApplicationPage';

// The page calls the real typed client; only the server behind `fetch` is a stand-in, answering
// one application's endpoint the way the API does.
const ACME_ID = '00000000-0000-4000-8000-000000000001';
const MISSING_ID = '00000000-0000-4000-8000-000000000009';

const APPLIED_AT = '2026-10-30T12:00:00.000Z';

const JOB_URL = 'https://jobs.example.com/acme/1';

/** Acme's application as the API sends it. */
const acme = (
  status = 'interviewing',
  appliedAt: string | null = APPLIED_AT,
  jobUrl: string | null = JOB_URL,
) => ({
  id: ACME_ID,
  company: 'Acme',
  jobTitle: 'Engineer',
  jobUrl,
  status,
  appliedAt,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-02T00:00:00.000Z',
});

let stored: ReturnType<typeof acme>;

/** Every path the page asked the server for. */
let requested: string[];

/** The server fails with a 500, which has nothing to do with the application. */
let serverError: boolean;

function fakeServer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const { pathname } = new URL(request.url);

  requested.push(pathname);

  if (serverError) return Promise.resolve(new Response(null, { status: 500 }));

  if (request.method === 'GET' && pathname === `/api/applications/${ACME_ID}`)
    return Promise.resolve(Response.json(stored));

  // A missing application and another user's answer the same (CLAUDE.md, rule 8).
  return Promise.resolve(Response.json({ _tag: 'ApplicationNotFound' }, { status: 404 }));
}

beforeEach(() => {
  stored = acme();
  requested = [];
  serverError = false;
  vi.stubGlobal('fetch', fakeServer);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const renderPage = (applicationId: string) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createTestRouter(<ApplicationPage applicationId={applicationId} />, '/elsewhere');

  render(
    <QueryClientProvider client={queryClient}>
      <TestRouterProvider router={router} />
    </QueryClientProvider>,
  );

  return router;
};

/** The page's fields, as label → value. */
const fields = () => {
  const labels = screen.getAllByRole('term').map((term) => term.textContent);
  const values = screen.getAllByRole('definition').map((value) => value.textContent);

  return Object.fromEntries(labels.map((label, i) => [label, values[i]]));
};

const expectNotFound = async () => {
  expect(await screen.findByRole('heading', { name: 'Application not found' })).toBeDefined();
  expect(screen.getByRole('link', { name: 'Back to my applications' }).getAttribute('href')).toBe(
    '/',
  );
  expect(screen.queryByText('Acme')).toBeNull();
};

describe('ApplicationPage', () => {
  it('shows the application’s company, job title, job link, status and applied date', async () => {
    renderPage(ACME_ID);

    expect(await screen.findByRole('heading', { name: 'Acme' })).toBeDefined();
    expect(fields()).toEqual({
      'Job title': 'Engineer',
      'Job link': 'https://jobs.example.com/acme/1',
      Status: 'Interviewing',
      Applied: new Date(APPLIED_AT).toLocaleDateString(),
    });

    const jobLink = screen.getByRole('link', { name: 'https://jobs.example.com/acme/1' });

    expect(jobLink.getAttribute('href')).toBe('https://jobs.example.com/acme/1');
    // A page outside the app opens in its own tab, without access to this one.
    expect(jobLink.getAttribute('target')).toBe('_blank');
    expect(jobLink.getAttribute('rel')).toBe('noreferrer');
  });

  it('shows a saved application as Not sent, with no job link when it has none', async () => {
    stored = acme('saved', null, null);
    renderPage(ACME_ID);

    expect(await screen.findByRole('heading', { name: 'Acme' })).toBeDefined();
    expect(fields()).toEqual({ 'Job title': 'Engineer', Status: 'Saved', Applied: 'Not sent' });
  });

  it('links back to the applications', async () => {
    const router = renderPage(ACME_ID);

    await screen.findByRole('heading', { name: 'Acme' });
    await userEvent.click(screen.getByRole('link', { name: 'Back to my applications' }));

    expect(router.state.location.pathname).toBe('/');
  });

  it('says the application is not found when the server has none with that id', async () => {
    renderPage(MISSING_ID);

    await expectNotFound();
    // An answer, not a failure: no error, and asked only once.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(requested).toEqual([`/api/applications/${MISSING_ID}`]);
  });

  it('says a malformed id is not found, without asking the server', async () => {
    renderPage('not-an-id');

    await expectNotFound();
    expect(requested).toEqual([]);
  });

  it('shows any other failure as an error, with the way back', async () => {
    serverError = true;
    renderPage(ACME_ID);

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Something went wrong. Please try again.',
    );
    expect(screen.queryByRole('heading', { name: 'Application not found' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to my applications' })).toBeDefined();
  });

  it('shows loading until the server answers', async () => {
    renderPage(ACME_ID);

    expect(await screen.findByText('Loading…')).toBeDefined();
    expect(await screen.findByRole('heading', { name: 'Acme' })).toBeDefined();
    expect(screen.queryByText('Loading…')).toBeNull();
  });
});
