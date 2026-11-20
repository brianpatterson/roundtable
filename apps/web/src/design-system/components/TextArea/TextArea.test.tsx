import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { TextArea } from './TextArea';

describe('TextArea', () => {
  it('is a multi-line text box found by its label, with its help text as the description', () => {
    render(<TextArea label="What went wrong?" description="Kept private" />);

    const textarea = screen.getByRole('textbox', {
      name: 'What went wrong?',
      description: 'Kept private',
    });

    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea.getAttribute('rows')).toBe('4');
  });

  it('takes several lines of typing, up to its maxLength', async () => {
    function Controlled() {
      const [value, setValue] = useState('');

      return (
        <TextArea
          label="Details"
          maxLength={10}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      );
    }

    render(<Controlled />);
    await userEvent.type(screen.getByLabelText('Details'), 'one{Enter}two and more');

    // Ten characters, the line break included.
    expect(screen.getByLabelText<HTMLTextAreaElement>('Details').value).toBe('one\ntwo an');
  });

  it('marks itself invalid and announces the error', () => {
    render(<TextArea label="Details" error="Describe the problem" rows={6} />);

    const textarea = screen.getByRole('textbox', { name: 'Details' });

    expect(textarea.getAttribute('aria-invalid')).toBe('true');
    expect(textarea.getAttribute('rows')).toBe('6');
    expect(screen.getByText('Describe the problem')).toBeDefined();
  });
});
