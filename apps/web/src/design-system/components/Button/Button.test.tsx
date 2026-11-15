import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';

describe('Button', () => {
  it('is a button that runs its action when clicked', async () => {
    const onClick = vi.fn();

    render(<Button onClick={onClick}>Save</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onClick).toHaveBeenCalledOnce();
  });

  it("doesn't submit a form unless asked to", () => {
    render(
      <>
        <Button>Plain</Button>
        <Button type="submit">Submit</Button>
      </>,
    );

    expect(screen.getByRole('button', { name: 'Plain' }).getAttribute('type')).toBe('button');
    expect(screen.getByRole('button', { name: 'Submit' }).getAttribute('type')).toBe('submit');
  });

  it('ignores clicks while disabled', async () => {
    const onClick = vi.fn();

    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onClick).not.toHaveBeenCalled();
  });
});
