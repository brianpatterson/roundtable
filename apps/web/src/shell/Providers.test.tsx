import { useMutation } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button, useSnackbar } from '../design-system';
import { api } from '../shared/api';
import { Providers } from './Providers';

function ShowsASnackbar() {
  const showSnackbar = useSnackbar();

  return <Button onClick={() => showSnackbar("Couldn't save.")}>Save</Button>;
}

const ACME_ID = '00000000-0000-4000-8000-000000000001';

/** A module's mutation through the real typed client; it says when it has failed. */
function ChangesStatus({ errorSnackbar }: { readonly errorSnackbar: boolean }) {
  const change = useMutation({
    mutationFn: () => api.updateApplication(ACME_ID, { status: 'offer' }),
    meta: errorSnackbar ? { errorSnackbar } : undefined,
  });

  return (
    <>
      <Button onClick={() => change.mutate()}>Change status</Button>
      {change.isError && <p>Change failed</p>}
    </>
  );
}

/** How the stand-in server answers every request. */
let answer: () => Response;

beforeEach(() => {
  vi.stubGlobal('fetch', () => Promise.resolve(answer()));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const serverError = () => new Response(null, { status: 500 });

const unauthorized = () => Response.json({ _tag: 'Unauthorized' }, { status: 401 });

const changeStatus = async (errorSnackbar: boolean) => {
  render(
    <Providers>
      <ChangesStatus errorSnackbar={errorSnackbar} />
    </Providers>,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Change status' }));
  // The mutation has settled, and the shell has seen its error.
  await screen.findByText('Change failed');
};

describe('Providers', () => {
  it('mounts the snackbars once for every module inside it', async () => {
    render(
      <Providers>
        <ShowsASnackbar />
      </Providers>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect((await screen.findByRole('alert')).textContent).toBe("Couldn't save.");
  });
});

describe('Providers: which mutation errors reach the snackbar', () => {
  it("shows the error's message for a mutation that opts in", async () => {
    answer = serverError;
    await changeStatus(true);

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Something went wrong. Please try again.',
    );
  });

  it('shows nothing for an opted-in mutation that fails because the session ended', async () => {
    answer = unauthorized;
    await changeStatus(true);

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it("shows nothing for a mutation that doesn't opt in: it shows its own error", async () => {
    answer = serverError;
    await changeStatus(false);

    expect(screen.queryByRole('alert')).toBeNull();
  });
});
