import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDiagnostics, recordError } from '../../shared/diagnostics';
import { ReportProblem } from './index';

// The support module through its interface, against a stand-in API behind `fetch`.
const REPORT_ID = '00000000-0000-4000-8000-0000000000aa';

/** What the API received, in order. */
let received: unknown[];

/** How the API answers a report. */
let answer: () => Response;

beforeEach(() => {
  received = [];
  clearDiagnostics();
  answer = () => Response.json({ id: REPORT_ID }, { status: 201 });
  window.history.replaceState(null, '', '/reset-password?token=secret#top');
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);

    if (new URL(request.url).pathname !== '/api/reports')
      return new Response(null, { status: 404 });

    received.push(await request.json());

    return answer();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

function renderReport(defaultReplyEmail?: string) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ReportProblem defaultReplyEmail={defaultReplyEmail} />
    </QueryClientProvider>,
  );
}

const openForm = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Report a problem' }));

  return screen.findByRole('alertdialog', { name: 'Report a problem' });
};

describe('ReportProblem', () => {
  it('opens a short form: a required description of at most 2,000 characters, an optional reply email, and a privacy note', async () => {
    renderReport();
    const dialog = await openForm();

    expect(dialog.textContent).toContain(
      'What you write, and the recent errors we attach, stay private: only the people who run Roundtable and the AI assistant that helps them fix bugs read them.',
    );

    const description = screen.getByRole('textbox', {
      name: 'What went wrong?',
      description: 'Up to 2,000 characters',
    });

    const email = screen.getByRole('textbox', {
      name: 'Reply email',
      description: "Optional: only if you'd like an answer",
    });

    expect(description.hasAttribute('required')).toBe(true);
    expect(description.getAttribute('maxlength')).toBe('2000');
    expect(email.hasAttribute('required')).toBe(false);
    expect(email.getAttribute('type')).toBe('email');
    expect(screen.getByLabelText<HTMLInputElement>('Reply email').value).toBe('');
  });

  it('sends the report with the page path but no query string, and confirms it with its id', async () => {
    renderReport();
    await openForm();
    await userEvent.type(screen.getByLabelText('What went wrong?'), 'GitHub sign-in failed');
    await userEvent.type(screen.getByLabelText('Reply email'), 'me@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }));

    expect((await screen.findByRole('status')).textContent).toBe(
      `Report ${REPORT_ID}. Quote it if you write to us about this.`,
    );
    expect(
      screen.getByRole('alertdialog', {
        name: 'Report a problem',
        description: 'Thanks: your report reached us.',
      }),
    ).toBeDefined();
    expect(received).toEqual([
      {
        description: 'GitHub sign-in failed',
        replyEmail: 'me@example.com',
        pagePath: '/reset-password',
        diagnostics: expect.objectContaining({ requests: [], errors: [] }),
      },
    ]);

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('attaches what the browser saw: the window, the theme and the errors it hit', async () => {
    document.documentElement.dataset['theme'] = 'dark';
    recordError({ message: 'TypeError: list is undefined' });
    renderReport();
    await openForm();
    await userEvent.type(screen.getByLabelText('What went wrong?'), 'The list vanished');
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await screen.findByRole('status');
    delete document.documentElement.dataset['theme'];

    expect(received).toEqual([
      expect.objectContaining({
        diagnostics: {
          viewport: { width: window.innerWidth, height: window.innerHeight },
          theme: 'dark',
          requests: [],
          errors: [
            expect.objectContaining({ message: 'TypeError: list is undefined', secondsBefore: 0 }),
          ],
        },
      }),
    ]);
  });

  it('pre-fills the reply email, and sends none when the user clears it', async () => {
    renderReport('ada@example.com');
    await openForm();

    expect(screen.getByLabelText<HTMLInputElement>('Reply email').value).toBe('ada@example.com');

    await userEvent.clear(screen.getByLabelText('Reply email'));
    // Spaces alone count as no address: the email input strips them.
    await userEvent.type(screen.getByLabelText('Reply email'), '   ');
    await userEvent.type(screen.getByLabelText('What went wrong?'), 'Broken');
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }));

    await screen.findByRole('status');
    expect(received).toEqual([
      {
        description: 'Broken',
        replyEmail: null,
        pagePath: '/reset-password',
        diagnostics: expect.any(Object),
      },
    ]);
  });

  it('shows why a report was refused, keeping what the user wrote', async () => {
    answer = () => Response.json({ _tag: 'ReportRateLimited' }, { status: 429 });
    renderReport();
    await openForm();
    await userEvent.type(screen.getByLabelText('What went wrong?'), 'Broken');
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      "We've received a lot of reports in the last hour. Please try again later.",
    );
    expect(screen.getByLabelText<HTMLTextAreaElement>('What went wrong?').value).toBe('Broken');
    expect(screen.getByRole('button', { name: 'Send report' })).toBeDefined();
  });

  it('starts empty again after Cancel, and sends nothing', async () => {
    renderReport('ada@example.com');
    await openForm();
    await userEvent.type(screen.getByLabelText('What went wrong?'), 'Half a thought');
    await userEvent.clear(screen.getByLabelText('Reply email'));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();

    await openForm();
    expect(screen.getByLabelText<HTMLTextAreaElement>('What went wrong?').value).toBe('');
    expect(screen.getByLabelText<HTMLInputElement>('Reply email').value).toBe('ada@example.com');
    expect(received).toEqual([]);
  });

  it('opens a fresh form after a report was sent', async () => {
    renderReport();
    await openForm();
    await userEvent.type(screen.getByLabelText('What went wrong?'), 'Broken');
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await screen.findByRole('status');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));

    await openForm();
    expect(screen.getByLabelText<HTMLTextAreaElement>('What went wrong?').value).toBe('');
    expect(screen.queryByRole('status')).toBeNull();
  });
});
