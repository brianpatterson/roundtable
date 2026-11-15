import { Select } from '../components/Select/Select';
import { useTheme, type ThemePreference } from './ThemeProvider';

const options: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System theme' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** Lets the viewer pick light, dark, or follow the system. */
export function ThemeSelect() {
  const { preference, setPreference } = useTheme();

  return (
    <Select
      label="Theme"
      hideLabel
      options={options}
      value={preference}
      onValueChange={setPreference}
    />
  );
}
