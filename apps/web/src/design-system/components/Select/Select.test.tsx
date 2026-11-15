import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Select } from './Select';

const options = [
  { value: 'applied', label: 'Applied' },
  { value: 'offer', label: 'Offer' },
] as const;

describe('Select', () => {
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
