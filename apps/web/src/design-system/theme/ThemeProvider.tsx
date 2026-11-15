import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import '../tokens/tokens.css';
import '../tokens/base.css';

export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

const STORAGE_KEY = 'roundtable.theme';

const isThemePreference = (value: string | null): value is ThemePreference =>
  THEME_PREFERENCES.some((preference) => preference === value);

// Storage can be missing or throw (private windows, blocked site data): fall back to the system.
function readPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);

    return isThemePreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

function writePreference(preference: ThemePreference) {
  try {
    window.localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Not remembered across visits, but the theme still applies for this one.
  }
}

interface ThemeContextValue {
  readonly preference: ThemePreference;
  readonly setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Applies the theme: `data-theme` on <html> selects the tokens' color scheme. "system" removes
 * the attribute, so the operating system's light or dark setting decides.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState(readPreference);

  useEffect(() => {
    const root = document.documentElement;

    if (preference === 'system') delete root.dataset.theme;
    else root.dataset.theme = preference;
  }, [preference]);

  function setPreference(next: ThemePreference) {
    setPreferenceState(next);
    writePreference(next);
  }

  return (
    <ThemeContext.Provider value={{ preference, setPreference }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const theme = useContext(ThemeContext);

  if (!theme) throw new Error('useTheme must be used inside a ThemeProvider');

  return theme;
}
