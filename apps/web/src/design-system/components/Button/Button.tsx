import { Button as BaseButton } from '@base-ui/react/button';
import styles from './Button.module.css';

/** Material's button emphasis levels, highest first. */
export type ButtonVariant = 'filled' | 'tonal' | 'outlined' | 'text';

export interface ButtonProps extends Omit<BaseButton.Props, 'className' | 'style'> {
  /** Defaults to `filled`. Use one filled button per view for the main action. */
  readonly variant?: ButtonVariant;
}

export function Button({ variant = 'filled', type = 'button', ...props }: ButtonProps) {
  return <BaseButton {...props} type={type} className={`${styles.button} ${styles[variant]}`} />;
}
