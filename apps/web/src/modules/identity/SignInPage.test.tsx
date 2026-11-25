import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PASSWORD_MIN_LENGTH } from '@roundtable/contract';
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
  const client = new QueryClient();

  render(
    <QueryClientProvider client={client}>
      <SignInPage sessionEnded={sessionEnded} />
    </QueryClientProvider>,
  );

  return client;
};

describe('SignInPage: providers', () => {
  it('offers every sign-in provider the server has, by name', async () => {
    providers = ['github', 'google'];
    await renderPage();

    expect(await screen.findByRole('button', { name: 'Continue with GitHub' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeDefined();
  });

  it('shows neither provider buttons nor the "or" between them when the server offers none', async () => {
    // An empty list changes nothing on screen, so start with a provider to see the config arrive,
    // then have the server drop it and wait for its button to go.
    providers = ['github'];
    const client = await renderPage();

    await screen.findByRole('button', { name: 'Continue with GitHub' });
    providers = [];
    await client.invalidateQueries();

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Continue with GitHub' })).toBeNull(),
    );
    expect(screen.queryByText('or')).toBeNull();
  });

  it('leaves the providers off the reset-password form', async () => {
    providers = ['github'];
    await renderPage();

    await screen.findByRole('button', { name: 'Continue with GitHub' });
    await userEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));

    expect(screen.queryByRole('button', { name: 'Continue with GitHub' })).toBeNull();
    expect(screen.queryByText('or')).toBeNull();
  });
});

describe('SignInPage: modes', () => {
  const heading = () => screen.getByRole('heading', { level: 2 }).textContent;

  it('names each form in its heading', async () => {
    await renderPage();

    expect(heading()).toBe('Sign in');
    await userEvent.click(screen.getByRole('button', { name: 'Create an account' }));
    expect(heading()).toBe('Create an account');
    await userEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
    await userEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(heading()).toBe('Reset password');
  });

  it('goes back to the sign-in form from creating an account', async () => {
    await renderPage();

    await userEvent.click(screen.getByRole('button', { name: 'Create an account' }));

    expect(screen.queryByRole('button', { name: 'Forgot password?' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));

    expect(heading()).toBe('Sign in');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Forgot password?' })).toBeDefined();
  });

  it('gives the password rule only when creating an account', async () => {
    await renderPage();

    expect(screen.queryByText(/At least/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Create an account' }));

    expect(screen.getByText(`At least ${PASSWORD_MIN_LENGTH} characters`)).toBeDefined();
  });

  it('tells password managers to fill a saved password on sign-in and suggest a new one on sign-up', async () => {
    await renderPage();

    expect(screen.getByLabelText('Password').getAttribute('autocomplete')).toBe('current-password');
    await userEvent.click(screen.getByRole('button', { name: 'Create an account' }));

    expect(screen.getByLabelText('Password').getAttribute('autocomplete')).toBe('new-password');
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

  it('asks the user to confirm their email when they sign in before confirming it', async () => {
    answers = [
      () =>
        Promise.resolve(
          Response.json(
            { code: 'EMAIL_NOT_VERIFIED', message: 'Email not verified' },
            { status: 403 },
          ),
        ),
    ];
    await renderPage();

    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect((await screen.findByRole('status')).textContent).toBe(
      'Confirm your email first: check ada@example.com (and spam) for the link.',
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('after creating an account, says where the confirmation link went and clears the password', async () => {
    await renderPage();

    await userEvent.click(screen.getByRole('button', { name: 'Create an account' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Ada');
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect((await screen.findByRole('status')).textContent).toBe(
      'Check ada@example.com for a link to finish creating your account.',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Password').value).toBe('');
  });

  it('after asking for a reset link, says one is on its way', async () => {
    await renderPage();

    await userEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect((await screen.findByRole('status')).textContent).toBe(
      'If that email has an account, a reset link is on its way.',
    );
  });

  it('says nothing after a successful sign-in', async () => {
    await renderPage();

    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sign in' }).hasAttribute('disabled')).toBe(false),
    );
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Password').value).toBe('correct horse');
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

  it('explains an expired confirmation link the same way', async () => {
    window.history.replaceState(null, '', '/?error=TOKEN_EXPIRED');
    await renderPage();

    expect(screen.getByRole('alert').textContent).toBe(
      'That confirmation link is invalid or has expired. Sign in to get a new one.',
    );
  });

  it('leaves the address bar and its history entry alone when there is nothing to drop', async () => {
    window.history.replaceState({ kept: true }, '', '/applications/a1#notes');
    await renderPage();

    expect(screen.queryByRole('alert')).toBeNull();
    expect(window.location.pathname + window.location.hash).toBe('/applications/a1#notes');
    expect(window.history.state).toEqual({ kept: true });
  });
});
