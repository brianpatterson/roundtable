import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { setUpFakeApi } from '../../shared/testing/fake-api';
import { NewApplicationForm } from './NewApplicationForm';

// The form calls the real typed client, answered by the in-memory API.
const fake = setUpFakeApi();

/** The applications the form sent, as the contract decoded them. */
const sent = () => fake.received('applications.create');

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
      expect(sent()).toEqual([
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
      expect(sent()).toEqual([
        { company: 'Acme', jobTitle: 'Engineer', jobUrl: null, status: 'saved' },
      ]),
    );
  });

  it('adds as applied when Enter is pressed, even after a save for later', async () => {
    renderForm();
    await fillIn();
    await userEvent.click(screen.getByRole('button', { name: 'Save for later' }));
    await waitFor(() => expect(sent()).toHaveLength(1));

    await fillIn();
    await userEvent.type(screen.getByLabelText('Job title'), '{Enter}');

    await waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1]).toMatchObject({ status: 'applied' });
  });
});
