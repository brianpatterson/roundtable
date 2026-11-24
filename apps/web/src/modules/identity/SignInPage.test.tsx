import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The sign-in page on its own, against a stand-in for Better Auth's server and the API behind
// `fetch`. Better Auth's client keeps the `fetch` there is when it's created, so each test loads
// the page afresh after stubbing it.

/** A request the page sent to Better Auth (not the config or a session check): path and JSON body. */
interface SentRequest {
  readonly path: string;
  readonly body: unknown;
}

let sent: SentRequest[];

/** The sign-in providers the server offers. */
let providers: string[];

/** How the server answers the next requests, in order, each used once; then success. */
let answers: (() => Promise<Response>)[];

const success = () => Promise.resolve(Response.json({ redirect: false, status: true }));

const failure = (message: string) => () =>
  Promise.resolve(Response.json({ code: 'INVALID_EMAIL_OR_PASSWORD', message }, { status: 401 }));

async function answer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const { pathname } = new URL(request.url);

  if (pathname === '/api/auth-config') return Response.json({ providers });

  if (pathname === '/api/auth/get-session') return Response.json(null);

  const text = await request.text();

  sent.push({ path: pathname, body: text ? JSON.parse(text) : undefined });

  return (answers.shift() ?? success)();
}

beforeEach(() => {
  sent = [];
  providers = [];
  answers = [];
  vi.stubGlobal('fetch', vi.fn(answer));
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const renderPage = async ({ sessionEnded = false } = {}) => {
  vi.resetModules();
  const { SignInPage } = await import('./SignInPage');

  render(
    <QueryClientProvider client={new QueryClient()}>
      <SignInPage sessionEnded={sessionEnded} />
    </QueryClientProvider>,
  );
};

describe('SignInPage: providers', () => {
  it('offers every sign-in provider the server has, by name', async () => {
    providers = ['github', 'google'];
    await renderPage();

    expect(await screen.findByRole('button', { name: 'Continue with GitHub' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeDefined();
  });
});

describe('SignInPage: submitting', () => {
  it('signs in with the email and password typed', async () => {
    await renderPage();

    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      path: '/api/auth/sign-in/email',
      body: expect.objectContaining({ email: 'ada@example.com', password: 'correct horse' }),
    });
  });

  it('creates an account with the name, email and password typed, confirmed back at the start', async () => {
    await renderPage();

    await userEvent.click(screen.getByRole('button', { name: 'Create an account' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Ada');
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      path: '/api/auth/sign-up/email',
      body: expect.objectContaining({
        name: 'Ada',
        email: 'ada@example.com',
        password: 'correct horse',
        callbackURL: '/',
      }),
    });
  });

  it('asks for a reset link for the email typed, leading to the reset page', async () => {
    await renderPage();

    await userEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      path: '/api/auth/request-password-reset',
      body: expect.objectContaining({ email: 'ada@example.com', redirectTo: '/reset-password' }),
    });
  });

  it('stays on the page instead of letting the browser submit the form', async () => {
    let browserSubmits: boolean | undefined;

    const onSubmit = (event: Event) => {
      browserSubmits = !event.defaultPrevented;
    };

    document.addEventListener('submit', onSubmit);

    try {
      await renderPage();
      await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
      await userEvent.type(screen.getByLabelText('Password'), 'correct horse');
      await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

      await waitFor(() => expect(sent).toHaveLength(1));
      expect(browserSubmits).toBe(false);
    } finally {
      document.removeEventListener('submit', onSubmit);
    }
  });

  it('disables the button until the server answers', async () => {
    let release = () => {};

    answers = [() => new Promise<void>((resolve) => (release = resolve)).then(success)];
    await renderPage();

    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sign in' }).hasAttribute('disabled')).toBe(true),
    );
    release();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sign in' }).hasAttribute('disabled')).toBe(false),
    );
  });

  it('clears the last error when the user tries again and succeeds', async () => {
    answers = [failure('Invalid email or password')];
    await renderPage();

    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Invalid email or password');

    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(sent).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('clears the signed-out notice once the user signs in again', async () => {
    await renderPage({ sessionEnded: true });

    expect(screen.getByRole('status').textContent).toBe('You were signed out. Sign in again.');
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });
});

describe('SignInPage: a failed redirect', () => {
  it('explains a bad confirmation link and drops it from the address bar', async () => {
    window.history.replaceState(null, '', '/?error=INVALID_TOKEN');
    await renderPage();

    expect(screen.getByRole('alert').textContent).toBe(
      'That confirmation link is invalid or has expired. Sign in to get a new one.',
    );
    expect(window.location.search).toBe('');
  });

  it('leaves the address bar and its history entry alone when there is nothing to drop', async () => {
    window.history.replaceState({ kept: true }, '', '/applications/a1#notes');
    await renderPage();

    expect(screen.queryByRole('alert')).toBeNull();
    expect(window.location.pathname + window.location.hash).toBe('/applications/a1#notes');
    expect(window.history.state).toEqual({ kept: true });
  });
});
