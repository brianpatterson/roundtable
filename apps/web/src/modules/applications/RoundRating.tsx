import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { MAX_RATING_NOTE, type Round, type RoundRating as Rating } from '@roundtable/contract';
import { Alert, Button, Dialog, Select, TextArea } from '../../design-system';
import { api } from '../../shared/api';
import { roundsQueryKey } from './queries';
import styles from './Rounds.module.css';

// A Round's Self-rating (GLOSSARY.md): the user's own score for it, 1 (went badly) to 5 (went
// well), with a note on what went wrong. Both are optional, and saving replaces both.

type RatingChoice = 'none' | '1' | '2' | '3' | '4' | '5';

const ratingOptions = [
  { value: 'none', label: 'Not rated' },
  { value: '1', label: '1 – Went badly' },
  { value: '2', label: '2' },
  { value: '3', label: '3' },
  { value: '4', label: '4' },
  { value: '5', label: '5 – Went well' },
] as const satisfies readonly { value: RatingChoice; label: string }[];

const choiceOf = (selfRating: number | null): RatingChoice =>
  ratingOptions.find((option) => option.value === String(selfRating))?.value ?? 'none';

/** What the dialog asks the API for: only what's set, so a cleared field is left out. */
const ratingOf = (choice: RatingChoice, note: string): Rating => ({
  ...(choice !== 'none' && { selfRating: Number(choice) }),
  ...(note.trim() && { ratingNote: note }),
});

/** The Round's Self-rating and note as the list shows them, with a button to change them. */
export function RoundRating({ round, name }: { round: Round; name: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<RatingChoice>('none');
  const [note, setNote] = useState('');

  const save = useMutation({
    mutationFn: (rating: Rating) => api.rateRound(round.applicationId, round.id, rating),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: roundsQueryKey(round.applicationId) }),
  });

  const rated = round.selfRating !== null || round.ratingNote !== null;

  const openDialog = () => {
    save.reset();
    setChoice(choiceOf(round.selfRating));
    setNote(round.ratingNote ?? '');
    setOpen(true);
  };

  // Closing mid-request would hide a failure, so the dialog waits for the answer.
  const close = () => {
    if (!save.isPending) setOpen(false);
  };

  const tooLong = note.length > MAX_RATING_NOTE;

  return (
    <div role="group" aria-label={`${name} self-rating`} className={styles.rating}>
      <div className={styles.ratingLine}>
        <span>
          {round.selfRating === null
            ? 'Not rated yet'
            : `Self-rating: ${round.selfRating} of 5`}
        </span>
        <Button
          variant="text"
          aria-label={`${rated ? 'Edit rating of' : 'Rate'} ${name}`}
          onClick={openDialog}
        >
          {rated ? 'Edit rating' : 'Rate'}
        </Button>
      </div>
      {round.ratingNote !== null && <p className={styles.note}>{round.ratingNote}</p>}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        title={`Rate ${name}`}
        description="How it went, from 1 (badly) to 5 (well), and what went wrong."
        actions={
          <>
            <Button variant="text" disabled={save.isPending} onClick={close}>
              Cancel
            </Button>
            <Button
              disabled={save.isPending || tooLong}
              onClick={() => save.mutate(ratingOf(choice, note), { onSuccess: () => setOpen(false) })}
            >
              Save
            </Button>
          </>
        }
      >
        <Select label="Self-rating" options={ratingOptions} value={choice} onValueChange={setChoice} />
        <TextArea
          label="What went wrong"
          description={`Optional, up to ${MAX_RATING_NOTE} characters.`}
          value={note}
          error={
            tooLong
              ? `The note is ${note.length} characters; it can be at most ${MAX_RATING_NOTE}.`
              : null
          }
          onChange={(e) => setNote(e.target.value)}
        />
        {save.error && <Alert tone="error">{save.error.message}</Alert>}
      </Dialog>
    </div>
  );
}
