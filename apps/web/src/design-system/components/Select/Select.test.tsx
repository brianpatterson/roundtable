import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Select } from './Select';

const options = [
  { value: 'applied', label: 'Applied' },
  { value: 'offer', label: 'Offer' },
] as const;

describe('Select', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the selected option, named by its label', () => {
    render(<Select label="Status" options={options} value="applied" onValueChange={vi.fn()} />);

    expect(screen.getByRole('combobox', { name: 'Status' }).textContent).toContain('Applied');
  });

  it('reports the option the user picks', async () => {
    const onValueChange = vi.fn();

    render(
      <Select label="Status" options={options} value="applied" onValueChange={onValueChange} />,
    );
    await userEvent.click(screen.getByRole('combobox', { name: 'Status' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Offer' }));

    expect(onValueChange).toHaveBeenCalledWith('offer');
  });

  // Aligning the selected item over the trigger scrolled the options above it out of view when
  // the field sat near the top of the window (the theme select in the header hid "System theme").
  it('opens the menu below the field, so options before the selected one stay in view', async () => {
    // jsdom lays nothing out; without a window and a field away from its edges, Base UI falls
    // back to opening below by itself and the test couldn't tell the difference.
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(800);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(100, 200, 160, 40),
    );
    render(<Select label="Status" options={options} value="offer" onValueChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Status' }));

    const listbox = await screen.findByRole('listbox');

    expect(listbox.closest('[data-side]')?.getAttribute('data-side')).toBe('bottom');
  });

  it('keeps a hidden label for screen readers', () => {
    render(
      <Select
        label="Status for Acme"
        hideLabel
        options={options}
        value="offer"
        onValueChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('combobox', { name: 'Status for Acme' })).toBeDefined();
  });
});
