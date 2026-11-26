import { Select as BaseSelect } from '@base-ui/react/select';
import styles from './Select.module.css';

export interface SelectOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
}

/** Options listed under a heading, announced as a group named by its `label`. */
export interface SelectGroup<Value extends string> {
  readonly label: string;
  readonly options: readonly SelectOption<Value>[];
}

interface SelectBaseProps<Value extends string> {
  /** Announced by screen readers; shown above the field unless `hideLabel` is set. */
  readonly label: string;
  /** For compact places (a table cell) where the column header already says what it is. */
  readonly hideLabel?: boolean;
  readonly value: Value;
  readonly onValueChange: (value: Value) => void;
  readonly disabled?: boolean;
}

/** A flat list of `options`, or `groups` of them under headings: never both. */
export type SelectProps<Value extends string> = SelectBaseProps<Value> &
  (
    | { readonly options: readonly SelectOption<Value>[]; readonly groups?: never }
    | { readonly groups: readonly SelectGroup<Value>[]; readonly options?: never }
  );

/**
 * Material's outlined select menu. Base UI handles the keyboard, focus and positioning.
 *
 * Pass `groups` instead of `options` to list options under headings, in the order given: each
 * group is announced with its label, the arrow keys move through every option across groups, and
 * a group with no options isn't shown.
 */
export function Select<Value extends string>({
  label,
  hideLabel = false,
  value,
  onValueChange,
  disabled,
  ...list
}: SelectProps<Value>) {
  const groups = list.groups?.filter((group) => group.options.length > 0);
  const options = groups ? groups.flatMap((group) => group.options) : (list.options ?? []);

  return (
    <BaseSelect.Root
      items={options}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        const option = options.find((candidate) => candidate.value === next);

        if (option) onValueChange(option.value);
      }}
    >
      <div className={styles.field}>
        <BaseSelect.Label className={hideLabel ? styles.hiddenLabel : styles.label}>
          {label}
        </BaseSelect.Label>
        <BaseSelect.Trigger className={styles.trigger}>
          <BaseSelect.Value className={styles.value} />
          <BaseSelect.Icon className={styles.icon}>
            <ArrowIcon />
          </BaseSelect.Icon>
        </BaseSelect.Trigger>
      </div>
      <BaseSelect.Portal>
        {/* Below the field, like Material's menu. Base UI's default lays the selected item over
            the field, which scrolls earlier options out of view near the top of the window. */}
        <BaseSelect.Positioner
          className={styles.positioner}
          alignItemWithTrigger={false}
          sideOffset={4}
        >
          <BaseSelect.Popup className={styles.popup}>
            <BaseSelect.List>
              {groups ? (
                groups.map((group) => (
                  <BaseSelect.Group key={group.label}>
                    <BaseSelect.GroupLabel className={styles.groupLabel}>
                      {group.label}
                    </BaseSelect.GroupLabel>
                    <Items options={group.options} />
                  </BaseSelect.Group>
                ))
              ) : (
                <Items options={options} />
              )}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}

function Items<Value extends string>({
  options,
}: {
  readonly options: readonly SelectOption<Value>[];
}) {
  return options.map((option) => (
    <BaseSelect.Item key={option.value} value={option.value} className={styles.item}>
      <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
    </BaseSelect.Item>
  ));
}

function ArrowIcon() {
  return (
    <svg width="10" height="5" viewBox="0 0 10 5" aria-hidden="true">
      <path d="M0 0l5 5 5-5z" fill="currentColor" />
    </svg>
  );
}
