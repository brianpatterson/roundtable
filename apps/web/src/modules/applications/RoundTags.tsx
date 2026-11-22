import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { MAX_TAG_LENGTH, type Round } from '@roundtable/contract';
import { Alert, Button, Chip, TextField } from '../../design-system';
import { api } from '../../shared/api';
import { roundsQueryKey } from './queries';
import styles from './Rounds.module.css';

/** Why a Tag can't be added before it's sent, in plain words: blank or too long. */
function tagProblem(value: string) {
  const length = value.trim().length;

  if (length === 0) return 'Enter a tag.';

  return length > MAX_TAG_LENGTH ? `A tag can be at most ${MAX_TAG_LENGTH} characters.` : undefined;
}

/**
 * A Round's Tags (GLOSSARY.md), with a field to add one. A blank or too-long Tag is refused here;
 * the API keeps one Tag that differs from another only in case or surrounding spaces, and refuses
 * one too many. A message shows until the user types again, or a Tag is added.
 */
export function RoundTags({ round, name }: { round: Round; name: string }) {
  const queryClient = useQueryClient();
  const [tag, setTag] = useState('');
  const [problem, setProblem] = useState<string>();

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: roundsQueryKey(round.applicationId) });

  const remove = useMutation({
    mutationFn: (value: string) => api.removeTag(round.applicationId, round.id, value),
    onSuccess: refresh,
  });

  const add = useMutation({
    mutationFn: (value: string) => api.addTag(round.applicationId, round.id, value),
    onSuccess: () => {
      setTag('');
      // A removal that failed before is no longer what the user is looking at.
      remove.reset();

      return refresh();
    },
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

          const why = tagProblem(tag);

          setProblem(why);

          if (!why) add.mutate(tag);
        }}
      >
        <TextField
          label="Tag"
          value={tag}
          error={problem ?? add.error?.message}
          onChange={(e) => {
            setProblem(undefined);
            add.reset();
            remove.reset();
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
