import type { ComponentProps } from 'react';
import { Field } from '@base-ui/react/field';
import styles from './TextArea.module.css';

type TextAreaElementProps = Omit<ComponentProps<'textarea'>, 'className' | 'style' | 'children'>;

export interface TextAreaProps extends TextAreaElementProps {
  /** Always shown above the field, and announced by screen readers. */
  readonly label: string;
  /** Help text under the field. */
  readonly description?: string;
  /** Marks the field invalid and shows this message under it. */
  readonly error?: string | null;
}

/**
 * Material's outlined text field for several lines: TextField's look and labelling, on a
 * `<textarea>` the user can make taller.
 */
export function TextArea({ label, description, error, rows = 4, ...textarea }: TextAreaProps) {
  return (
    <Field.Root className={styles.field} invalid={Boolean(error)}>
      <Field.Label className={styles.label}>{label}</Field.Label>
      <Field.Control render={<textarea {...textarea} rows={rows} />} className={styles.textarea} />
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
