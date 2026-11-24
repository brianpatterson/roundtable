import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PASSWORD_MIN_LENGTH } from '@roundtable/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The reset page on its own, opened from the link in a reset email, against a stand-in for Better
// Auth's server behind `fetch`. Better Auth's client keeps the `fetch` there is when it's created,
// so each test loads the page afresh after stubbing it.

/** A request the page sent to Better Auth: path and JSON body. */
interface SentRequest {
  readonly path: string;
  readonly body: unknown;
}

let sent: SentRequest[];

/** How the server answers the next request; success when unset. */
let reply: () => Response;

const success = () => Response.json({ status: true });

async function answer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const text = await request.text();

  sent.push({ path: new URL(request.url).pathname, body: text ? JSON.parse(text) : undefined });

  return reply();
}

beforeEach(() => {
  sent = [];
  reply = success;
  vi.stubGlobal('fetch', vi.fn(answer));
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const renderPage = async (search: string) => {
  window.history.replaceState(null, '', `/reset-password${search}`);
  vi.resetModules();
  const { ResetPasswordPage } = await import('./ResetPasswordPage');

  render(<ResetPasswordPage />);
};

const choosePassword = async (password: string) => {
  await userEvent.type(screen.getByLabelText('New password'), password);
  await userEvent.click(screen.getByRole('button', { name: 'Update password' }));
};

describe('ResetPasswordPage: the link', () => {
  it('asks for a new password, saying how long it must be, when the link has a token', async () => {
    await renderPage('?token=t0k3n');

    expect(screen.getByRole('heading', { name: 'Choose a new password' })).toBeDefined();
    expect(screen.getByLabelText('New password')).toBeDefined();
    expect(screen.getByText(`At least ${PASSWORD_MIN_LENGTH} characters`)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Update password' })).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says the link is no good, with nothing to fill in, when it has no token', async () => {
    await renderPage('');

    expect(screen.getByRole('alert').textContent).toBe(
      'This reset link is invalid or has expired.',
    );
    expect(screen.queryByLabelText('New password')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Update password' })).toBeNull();
  });
});

describe('ResetPasswordPage: submitting', () => {
  it('resets the password to the one typed, with the token from the link', async () => {
    await renderPage('?token=t0k3n');

    await choosePassword('correct horse battery');

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      path: '/api/auth/reset-password',
      body: { newPassword: 'correct horse battery', token: 't0k3n' },
    });
  });

  it('stays on the page instead of letting the browser submit the form', async () => {
    let browserSubmits: boolean | undefined;

    const onSubmit = (event: Event) => {
      browserSubmits = !event.defaultPrevented;
    };

    document.addEventListener('submit', onSubmit);

    try {
      await renderPage('?token=t0k3n');
      await choosePassword('correct horse battery');

      await waitFor(() => expect(sent).toHaveLength(1));
      expect(browserSubmits).toBe(false);
    } finally {
      document.removeEventListener('submit', onSubmit);
    }
  });

  it('confirms the new password and offers to sign in once the server accepts it', async () => {
    await renderPage('?token=t0k3n');

    await choosePassword('correct horse battery');

    const status = await screen.findByRole('status');

    expect(status.textContent).toBe('Password updated. Sign in');
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/');
    expect(screen.queryByLabelText('New password')).toBeNull();
  });

  it("shows the server's reason and keeps the form when it refuses", async () => {
    reply = () =>
      Response.json({ code: 'INVALID_TOKEN', message: 'Invalid token' }, { status: 400 });
    await renderPage('?token=expired');

    await choosePassword('correct horse battery');

    expect((await screen.findByRole('alert')).textContent).toBe('Invalid token');
    expect(screen.getByLabelText('New password')).toBeDefined();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says something went wrong when the server refuses without a reason', async () => {
    reply = () => Response.json({}, { status: 500 });
    await renderPage('?token=t0k3n');

    await choosePassword('correct horse battery');

    expect((await screen.findByRole('alert')).textContent).toBe('Something went wrong');
    expect(screen.queryByRole('status')).toBeNull();
  });
});
