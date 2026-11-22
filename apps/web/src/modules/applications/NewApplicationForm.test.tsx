import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewApplicationForm } from './NewApplicationForm';

// The form calls the real typed client; only the server behind `fetch` is a stand-in, which keeps
// the bodies it was sent and answers like the API's create endpoint.
let sent: unknown[];

async function fakeServer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const body: unknown = await request.json();

  sent.push(body);

  return Response.json(
    {
      id: '00000000-0000-4000-8000-000000000001',
      company: 'Acme',
      jobTitle: 'Engineer',
      jobUrl: null,
      status: 'applied',
      appliedAt: '2026-11-21T00:00:00.000Z',
      createdAt: '2026-11-21T00:00:00.000Z',
      updatedAt: '2026-11-21T00:00:00.000Z',
    },
    { status: 201 },
  );
}

beforeEach(() => {
  sent = [];
  vi.stubGlobal('fetch', fakeServer);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const renderForm = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NewApplicationForm />
    </QueryClientProvider>,
  );

const fillIn = async () => {
  await userEvent.type(screen.getByLabelText('Company'), 'Acme');
  await userEvent.type(screen.getByLabelText('Job title'), 'Engineer');
};

describe('NewApplicationForm', () => {
  it('adds an application as applied, then clears the fields', async () => {
    renderForm();
    await fillIn();
    await userEvent.click(screen.getByRole('button', { name: 'Add as applied' }));

    await waitFor(() =>
      expect(sent).toEqual([
        { company: 'Acme', jobTitle: 'Engineer', jobUrl: null, status: 'applied' },
      ]),
    );
    await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>('Company').value).toBe(''));
  });

  it('saves an application for later without sending it', async () => {
    renderForm();
    await fillIn();
    await userEvent.click(screen.getByRole('button', { name: 'Save for later' }));

    await waitFor(() =>
      expect(sent).toEqual([
        { company: 'Acme', jobTitle: 'Engineer', jobUrl: null, status: 'saved' },
      ]),
    );
  });

  it('adds as applied when Enter is pressed, even after a save for later', async () => {
    renderForm();
    await fillIn();
    await userEvent.click(screen.getByRole('button', { name: 'Save for later' }));
    await waitFor(() => expect(sent).toHaveLength(1));

    await fillIn();
    await userEvent.type(screen.getByLabelText('Job title'), '{Enter}');

    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ status: 'applied' });
  });
});
