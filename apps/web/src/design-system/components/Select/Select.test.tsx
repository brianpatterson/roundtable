import { render, screen, waitFor, within } from '@testing-library/react';
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

const groups = [
  {
    label: 'Backend Engineer',
    options: [
      { value: 'system-design', label: 'System design' },
      { value: 'sql', label: 'SQL' },
    ],
  },
  { label: 'Empty', options: [] },
  {
    label: 'Other Skills',
    options: [{ value: 'negotiation', label: 'Negotiation' }],
  },
] as const;

describe('Select with groups', () => {
  it('lists each group, named by its label, with its options in the order given', async () => {
    render(<Select label="Skill" groups={groups} value="sql" onValueChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Skill' }));

    const listbox = await screen.findByRole('listbox');
    const persona = within(listbox).getByRole('group', { name: 'Backend Engineer' });
    const others = within(listbox).getByRole('group', { name: 'Other Skills' });

    expect(within(listbox).getAllByRole('group')).toEqual([persona, others]);
    expect(
      within(persona)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['System design', 'SQL']);
    expect(
      within(others)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Negotiation']);
  });

  it('hides a group with no options', async () => {
    render(<Select label="Skill" groups={groups} value="sql" onValueChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Skill' }));
    await screen.findByRole('listbox');

    expect(screen.queryByRole('group', { name: 'Empty' })).toBeNull();
    expect(screen.queryByText('Empty')).toBeNull();
  });

  it('shows the selected option on the trigger, whichever group it is in', () => {
    render(<Select label="Skill" groups={groups} value="negotiation" onValueChange={vi.fn()} />);

    expect(screen.getByRole('combobox', { name: 'Skill' }).textContent).toContain('Negotiation');
  });

  it('moves through the options across groups with the arrow keys, skipping the labels', async () => {
    const onValueChange = vi.fn();

    render(
      <Select label="Skill" groups={groups} value="system-design" onValueChange={onValueChange} />,
    );
    screen.getByRole('combobox', { name: 'Skill' }).focus();
    await userEvent.keyboard('{ArrowDown}');
    await screen.findByRole('listbox');
    await waitFor(() => {
      expect(
        screen.getByRole('option', { name: 'System design' }).hasAttribute('data-highlighted'),
      ).toBe(true);
    });
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{ArrowDown}');

    expect(
      screen.getByRole('option', { name: 'Negotiation' }).hasAttribute('data-highlighted'),
    ).toBe(true);

    await userEvent.keyboard('{Enter}');

    expect(onValueChange).toHaveBeenCalledWith('negotiation');
  });

  it('takes options or groups, never both', () => {
    render(
      // @ts-expect-error: a Select lists either flat options or groups of them.
      <Select
        label="Skill"
        options={options}
        groups={groups}
        value="sql"
        onValueChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('combobox', { name: 'Skill' })).toBeDefined();
  });

  it('lists the options of a group with no label on their own, outside any group', async () => {
    render(
      <Select
        label="Skill"
        groups={[{ options: [{ value: 'none', label: 'No skill' }] }, ...groups]}
        value="none"
        onValueChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('combobox', { name: 'Skill' }));

    const listbox = await screen.findByRole('listbox');
    const none = within(listbox).getByRole('option', { name: 'No skill' });

    expect(within(listbox).getAllByRole('option')[0]).toBe(none);
    expect(none.closest('[role="group"]')).toBeNull();
    expect(within(listbox).getAllByRole('group')).toHaveLength(2);
  });

  it('reports the option the user picks from a group', async () => {
    const onValueChange = vi.fn();

    render(<Select label="Skill" groups={groups} value="sql" onValueChange={onValueChange} />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Skill' }));
    await userEvent.click(await screen.findByRole('option', { name: 'System design' }));

    expect(onValueChange).toHaveBeenCalledWith('system-design');
  });
});
