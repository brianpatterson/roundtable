import type { ComponentProps } from 'react';
import { Field } from '@base-ui/react/field';
import styles from './TextField.module.css';

type InputProps = Omit<ComponentProps<'input'>, 'className' | 'style' | 'children'>;

export interface TextFieldProps extends InputProps {
  /** Always shown above the field, and announced by screen readers. */
  readonly label: string;
  /** Help text under the field. */
  readonly description?: string;
  /** Marks the field invalid and shows this message under it. */
  readonly error?: string | null;
}

/** Material's outlined text field, with a visible label (Base UI's Field wires up the ids). */
export function TextField({ label, description, error, ...input }: TextFieldProps) {
  return (
    <Field.Root className={styles.field} invalid={Boolean(error)}>
      <Field.Label className={styles.label}>{label}</Field.Label>
      <Field.Control {...input} className={styles.input} />
      {description && (
        <Field.Description className={styles.description}>{description}</Field.Description>
      )}
      {error && (
        <Field.Error className={styles.error} match>
          {error}
        </Field.Error>
      )}
    </Field.Root>
  );
}
