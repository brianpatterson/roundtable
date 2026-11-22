import { Button as BaseButton } from '@base-ui/react/button';
import styles from './Chip.module.css';

export interface ChipProps {
  /** The chip's text. */
  readonly label: string;
  /**
   * Shows a remove button after the label, named "Remove <label>" for screen readers. Without it,
   * the chip is plain text.
   */
  readonly onRemove?: () => void;
  /** Disables the remove button, e.g. while a removal is in flight. */
  readonly disabled?: boolean;
}

/** Material's input chip: a short label, optionally with a button that removes it. */
export function Chip({ label, onRemove, disabled }: ChipProps) {
  return (
    <span className={styles.chip}>
      <span className={styles.label}>{label}</span>
      {onRemove && (
        <BaseButton
          type="button"
          className={styles.remove}
          aria-label={`Remove ${label}`}
          disabled={disabled}
          onClick={onRemove}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
            <path
              d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
              fill="currentColor"
            />
          </svg>
        </BaseButton>
      )}
    </span>
  );
}
