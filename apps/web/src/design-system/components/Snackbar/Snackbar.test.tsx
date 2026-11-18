import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import tokensCss from '../../tokens/tokens.css?raw';
import { Button } from '../Button/Button';
import snackbarCss from './Snackbar.module.css?raw';
import { SNACKBAR_TIMEOUT_MS, SnackbarProvider, createSnackbars, useSnackbar } from './Snackbar';

// A caller like the real ones: something fails, and it shows the message.
function Example({ message = "Couldn't save." }: { readonly message?: string }) {
  const showSnackbar = useSnackbar();

  return <Button onClick={() => showSnackbar(message)}>Save</Button>;
}

const renderExample = (message?: string) =>
  render(
    <SnackbarProvider>
      <Example message={message} />
    </SnackbarProvider>,
  );

// Base UI renders an error toast as a non-modal alert dialog, hidden from assistive tech until the
// user moves into the notifications (F6), and announces a hidden role="alert" copy instead, so
// the message is read once. Queries for the visible snackbar include hidden elements.
const hidden = { hidden: true } as const;

const findSnackbar = () => screen.findByRole('alertdialog', hidden);

const querySnackbars = () => screen.queryAllByRole('alertdialog', hidden);

afterEach(() => {
  vi.useRealTimers();
});

describe('Snackbar', () => {
  it('shows the message, announced at once to screen readers', async () => {
    renderExample();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    const snackbar = await findSnackbar();

    expect(within(snackbar).getByText("Couldn't save.")).toBeDefined();
    expect(snackbar.getAttribute('aria-modal')).toBe('false');
    expect(screen.getByRole('alert').textContent).toBe("Couldn't save.");
  });

  it('disappears when its Dismiss button is activated', async () => {
    renderExample();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    const snackbar = await findSnackbar();

    await userEvent.click(within(snackbar).getByRole('button', { name: 'Dismiss', ...hidden }));

    await waitFor(() => expect(querySnackbars()).toEqual([]));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('disappears on its own after six seconds, not before', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderExample();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await findSnackbar();

    expect(SNACKBAR_TIMEOUT_MS).toBe(6000);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(querySnackbars()).toHaveLength(1);

    await act(() => vi.advanceTimersByTimeAsync(1500));
    await waitFor(() => expect(querySnackbars()).toEqual([]));
  });

  it('shows each message when several arrive, losing none', async () => {
    renderExample();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(querySnackbars()).toHaveLength(2));
    expect(screen.getAllByRole('alert')).toHaveLength(2);
  });

  it('shows a message from outside React through the snackbars it was given', async () => {
    const snackbars = createSnackbars();

    render(
      <SnackbarProvider snackbars={snackbars}>
        <Example message="From a component." />
      </SnackbarProvider>,
    );
    act(() => snackbars.show('From outside.'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Both callers reach the same snackbars.
    await waitFor(() => expect(querySnackbars()).toHaveLength(2));
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual(
      expect.arrayContaining(['From outside.', 'From a component.']),
    );
  });

  // jsdom applies no stylesheets, so the styles are checked as text (ADR-0024: tokens, not values).
  it("uses Material's inverse surface, defined for light and dark themes", () => {
    const snackbar = /\.snackbar \{[^}]*\}/.exec(snackbarCss)?.[0] ?? '';

    expect(snackbar).toContain('background: var(--ds-color-inverse-surface);');
    expect(snackbar).toContain('color: var(--ds-color-inverse-on-surface);');
    // Its Dismiss button takes the inverse primary color.
    expect(snackbar).toContain('--ds-color-primary: var(--ds-color-inverse-primary);');

    for (const role of ['inverse-surface', 'inverse-on-surface', 'inverse-primary'])
      expect(tokensCss).toMatch(new RegExp(`--ds-color-${role}: light-dark\\(.+, .+\\);`));
  });
});
