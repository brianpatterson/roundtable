import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { ThemeProvider } from './ThemeProvider';
import { ThemeSelect } from './ThemeSelect';

function renderThemeSelect() {
  render(
    <ThemeProvider>
      <ThemeSelect />
    </ThemeProvider>,
  );
}

async function pick(label: string) {
  await userEvent.click(screen.getByRole('combobox', { name: 'Theme' }));
  await userEvent.click(await screen.findByRole('option', { name: label }));
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('follows the system until the viewer picks a theme', () => {
    renderThemeSelect();

    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('applies and remembers a picked theme', async () => {
    renderThemeSelect();
    await pick('Dark');

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem('roundtable.theme')).toBe('dark');
  });

  it('starts from the remembered theme', () => {
    window.localStorage.setItem('roundtable.theme', 'light');
    renderThemeSelect();

    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('ignores a stored value it does not know', () => {
    window.localStorage.setItem('roundtable.theme', 'sepia');
    renderThemeSelect();

    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});
