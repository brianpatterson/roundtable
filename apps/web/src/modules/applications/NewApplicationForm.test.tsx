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
        { company: 'Acme', jobTitle: 'Engineer', jobUrl: null, status: 'applied', personaId: null },
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
        { company: 'Acme', jobTitle: 'Engineer', jobUrl: null, status: 'saved', personaId: null },
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

describe('NewApplicationForm: Persona', () => {
  const personaSelect = () => screen.findByRole('combobox', { name: 'Persona' });

  it('has no Persona field when the user has no active Persona', async () => {
    fake.seedPersona({ name: 'Designer', archivedAt: new Date() });
    renderForm();

    await waitFor(() => expect(fake.received('personas.list')).toHaveLength(1));
    // Let the answer render before checking it added nothing.
    await screen.findByLabelText('Company');
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Persona' })).toBeNull());

    await fillIn();
    await userEvent.click(screen.getByRole('button', { name: 'Add as applied' }));

    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toMatchObject({ personaId: null });
  });

  it('offers None, the default, and the active Personas by name', async () => {
    fake.seedPersona({ name: 'Platform engineer' });
    fake.seedPersona({ name: 'Backend engineer' });
    fake.seedPersona({ name: 'Designer', archivedAt: new Date() });
    renderForm();

    const select = await personaSelect();

    expect(select.textContent).toContain('None');

    await userEvent.click(select);

    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'None',
      'Backend engineer',
      'Platform engineer',
    ]);
  });

  it('sends the chosen Persona, then goes back to None', async () => {
    const backend = fake.seedPersona({ name: 'Backend engineer' });

    renderForm();
    await userEvent.click(await personaSelect());
    await userEvent.click(await screen.findByRole('option', { name: 'Backend engineer' }));
    await fillIn();
    await userEvent.click(screen.getByRole('button', { name: 'Add as applied' }));

    await waitFor(() =>
      expect(sent()).toEqual([
        {
          company: 'Acme',
          jobTitle: 'Engineer',
          jobUrl: null,
          status: 'applied',
          personaId: backend.id,
        },
      ]),
    );
    await waitFor(async () => expect((await personaSelect()).textContent).toContain('None'));
  });

  it('sends no Persona when None is left chosen', async () => {
    fake.seedPersona({ name: 'Backend engineer' });
    renderForm();
    await personaSelect();
    await fillIn();
    await userEvent.click(screen.getByRole('button', { name: 'Add as applied' }));

    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toMatchObject({ personaId: null });
  });
});
