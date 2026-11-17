// The design system's public interface (ADR-0024): modules and the shell import from here, never
// from the files behind it. Material-style components on Base UI, styled with CSS Modules and the
// tokens in tokens/. Only this folder imports @base-ui/react.
export { Alert, type AlertProps, type AlertTone } from './components/Alert/Alert';

export { Button, type ButtonProps, type ButtonVariant } from './components/Button/Button';

export { Dialog, type DialogProps } from './components/Dialog/Dialog';

export { Select, type SelectOption, type SelectProps } from './components/Select/Select';

export { TextField, type TextFieldProps } from './components/TextField/TextField';

export {
  THEME_PREFERENCES,
  ThemeProvider,
  useTheme,
  type ThemePreference,
} from './theme/ThemeProvider';

export { ThemeSelect } from './theme/ThemeSelect';
