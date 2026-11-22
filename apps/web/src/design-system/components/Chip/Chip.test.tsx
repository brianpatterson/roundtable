import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Chip } from './Chip';

describe('Chip', () => {
  it('shows its label, with no button unless it can be removed', () => {
    render(<Chip label="React" />);

    expect(screen.getByText('React')).toBeDefined();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('has a remove button named after its label that runs onRemove', async () => {
    const onRemove = vi.fn();

    render(<Chip label="SQL" onRemove={onRemove} />);

    const remove = screen.getByRole('button', { name: 'Remove SQL' });

    expect(remove.getAttribute('type')).toBe('button');

    await userEvent.click(remove);

    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('ignores clicks on the remove button while disabled', async () => {
    const onRemove = vi.fn();

    render(<Chip label="SQL" onRemove={onRemove} disabled />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove SQL' }));

    expect(onRemove).not.toHaveBeenCalled();
  });
});
