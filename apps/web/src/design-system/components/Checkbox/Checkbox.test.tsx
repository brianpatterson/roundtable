import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Checkbox } from './Checkbox';

const LABEL = 'Redo the LRU cache problem';

function Controlled({ initial = false }: { readonly initial?: boolean }) {
  const [checked, setChecked] = useState(initial);

  return <Checkbox label={LABEL} checked={checked} onCheckedChange={setChecked} />;
}

describe('Checkbox', () => {
  it('is a checkbox named by its visible label, with its checked state', () => {
    render(<Checkbox label={LABEL} checked onCheckedChange={vi.fn()} />);

    const checkbox = screen.getByRole('checkbox', { name: LABEL });

    expect(screen.getByText(LABEL)).toBeDefined();
    expect(checkbox.getAttribute('aria-checked')).toBe('true');
  });

  it('reports an unticked box as not checked', () => {
    render(<Checkbox label={LABEL} checked={false} onCheckedChange={vi.fn()} />);

    expect(screen.getByRole('checkbox', { name: LABEL }).getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  it('toggles when the box is clicked', async () => {
    render(<Controlled />);

    const checkbox = screen.getByRole('checkbox', { name: LABEL });

    await userEvent.click(checkbox);

    expect(checkbox.getAttribute('aria-checked')).toBe('true');

    await userEvent.click(checkbox);

    expect(checkbox.getAttribute('aria-checked')).toBe('false');
  });

  it('toggles when the label is clicked', async () => {
    render(<Controlled />);

    await userEvent.click(screen.getByText(LABEL));

    expect(screen.getByRole('checkbox', { name: LABEL }).getAttribute('aria-checked')).toBe('true');
  });

  it('toggles with Space once focused from the keyboard', async () => {
    render(<Controlled initial />);

    await userEvent.tab();

    const checkbox = screen.getByRole('checkbox', { name: LABEL });

    expect(document.activeElement).toBe(checkbox);

    await userEvent.keyboard(' ');

    expect(checkbox.getAttribute('aria-checked')).toBe('false');
  });

  it('passes the new state to onCheckedChange', async () => {
    const onCheckedChange = vi.fn();

    render(<Checkbox label={LABEL} checked={false} onCheckedChange={onCheckedChange} />);
    await userEvent.click(screen.getByRole('checkbox', { name: LABEL }));

    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("can't be toggled while disabled, by the box, the label or the keyboard", async () => {
    const onCheckedChange = vi.fn();

    render(<Checkbox label={LABEL} checked={false} onCheckedChange={onCheckedChange} disabled />);

    const checkbox = screen.getByRole('checkbox', { name: LABEL });

    expect(checkbox.getAttribute('aria-disabled')).toBe('true');

    await userEvent.click(checkbox);
    await userEvent.click(screen.getByText(LABEL));
    await userEvent.tab();
    await userEvent.keyboard(' ');

    expect(onCheckedChange).not.toHaveBeenCalled();
    expect(checkbox.getAttribute('aria-checked')).toBe('false');
  });
});
