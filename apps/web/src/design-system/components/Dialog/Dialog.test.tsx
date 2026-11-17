import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Button } from '../Button/Button';
import { Dialog } from './Dialog';

// A caller like the real ones: a button opens the dialog, and its own Cancel closes it.
function Example() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>Delete</Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Delete draft?"
        description="You can't undo this."
        actions={
          <>
            <Button variant="text" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button>Confirm</Button>
          </>
        }
      />
    </>
  );
}

const open = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

  return screen.findByRole('alertdialog');
};

describe('Dialog', () => {
  it('is an alert dialog labelled by its title and described by its description', async () => {
    render(<Example />);
    const dialog = await open();

    expect(screen.getByRole('alertdialog', { name: 'Delete draft?' })).toBe(dialog);
    expect(dialog.getAttribute('aria-describedby')).toBe(
      screen.getByText("You can't undo this.").id,
    );
  });

  it('moves focus inside when it opens and keeps it there', async () => {
    render(<Example />);
    const dialog = await open();

    // Base UI moves focus in on the next frame.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Confirm' });

    expect(document.activeElement).toBe(cancel);

    await userEvent.tab();

    expect(document.activeElement).toBe(confirm);

    // Past the last button, Base UI's focus guard sends focus back to the first, not the page.
    await userEvent.tab();
    await waitFor(() => expect(document.activeElement).toBe(cancel));

    await userEvent.tab({ shift: true });
    await waitFor(() => expect(document.activeElement).toBe(confirm));
  });

  it('closes on Escape and returns focus to the button that opened it', async () => {
    render(<Example />);
    await open();
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete' }));
  });

  it('closes from its own Cancel button', async () => {
    render(<Example />);
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
