import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { TextField } from './TextField';

describe('TextField', () => {
  it('is found by its label, with its help text as the description', () => {
    render(<TextField label="Email" description="We never share it" />);

    expect(
      screen.getByRole('textbox', { name: 'Email', description: 'We never share it' }),
    ).toBeDefined();
  });

  it('takes typing like a normal input', async () => {
    function Controlled() {
      const [value, setValue] = useState('');

      return <TextField label="Company" value={value} onChange={(e) => setValue(e.target.value)} />;
    }

    render(<Controlled />);
    await userEvent.type(screen.getByLabelText('Company'), 'Acme');

    expect(screen.getByLabelText<HTMLInputElement>('Company').value).toBe('Acme');
  });

  it('marks itself invalid and announces the error', () => {
    render(<TextField label="Email" error="That email is taken" />);

    const input = screen.getByRole('textbox', { name: 'Email' });

    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('That email is taken')).toBeDefined();
  });
});
