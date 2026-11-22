import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Round } from '@roundtable/contract';
import { Alert, Button, Chip, TextField } from '../../design-system';
import { api } from '../../shared/api';
import { roundsQueryKey } from './queries';
import styles from './Rounds.module.css';

/**
 * A Round's Tags (GLOSSARY.md), with a field to add one. The API keeps one Tag that differs from
 * another only in case or surrounding spaces, and says why it refuses one: blank, too long, or one
 * too many. The message shows under the field until the user types again.
 */
export function RoundTags({ round, name }: { round: Round; name: string }) {
  const queryClient = useQueryClient();
  const [tag, setTag] = useState('');

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: roundsQueryKey(round.applicationId) });

  const add = useMutation({
    mutationFn: (value: string) => api.addTag(round.applicationId, round.id, value),
    onSuccess: () => {
      setTag('');

      return refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (value: string) => api.removeTag(round.applicationId, round.id, value),
    onSuccess: refresh,
  });

  return (
    <div role="group" aria-label={`${name} tags`} className={styles.tags}>
      {round.tags.length > 0 && (
        <ul className={styles.chips} aria-label="Tags">
          {round.tags.map((value) => (
            <li key={value}>
              <Chip
                label={value}
                disabled={remove.isPending}
                onRemove={() => remove.mutate(value)}
              />
            </li>
          ))}
        </ul>
      )}
      {remove.isError && <Alert tone="error">{remove.error.message}</Alert>}
      <form
        className={styles.add}
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate(tag);
        }}
      >
        <TextField
          label="Tag"
          value={tag}
          error={add.error?.message}
          onChange={(e) => {
            add.reset();
            setTag(e.target.value);
          }}
        />
        <Button type="submit" variant="text" disabled={add.isPending}>
          Add tag
        </Button>
      </form>
    </div>
  );
}
