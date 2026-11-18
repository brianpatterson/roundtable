import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Button, useSnackbar } from '../design-system';
import { Providers } from './Providers';

function ShowsASnackbar() {
  const showSnackbar = useSnackbar();

  return <Button onClick={() => showSnackbar("Couldn't save.")}>Save</Button>;
}

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
