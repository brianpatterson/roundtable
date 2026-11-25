import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox';
import styles from './Checkbox.module.css';

export interface CheckboxProps {
  /** Always shown beside the box, and announced by screen readers as its name. */
  readonly label: string;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  /** Can't be toggled, and is shown dimmed. */
  readonly disabled?: boolean;
}

/**
 * Material's checkbox with a visible label. The label wraps the box, so clicking either toggles
 * it; Base UI handles the role, the checked state and Space.
 */
export function Checkbox({ label, checked, onCheckedChange, disabled }: CheckboxProps) {
  return (
    <label className={styles.field} data-disabled={disabled ? '' : undefined}>
      <BaseCheckbox.Root
        className={styles.box}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onCheckedChange(next)}
      >
        <BaseCheckbox.Indicator className={styles.indicator}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
            <path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="currentColor" />
          </svg>
        </BaseCheckbox.Indicator>
      </BaseCheckbox.Root>
      <span className={styles.label}>{label}</span>
    </label>
  );
}
