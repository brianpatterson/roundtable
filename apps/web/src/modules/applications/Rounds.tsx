import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import {
  INTERVIEW_TYPES,
  RoundNotFound,
  type InterviewType,
  type Round,
} from '@roundtable/contract';
import { ApiError } from '@roundtable/contract/client';
import { Alert, Button, Dialog, Select } from '../../design-system';
import { api } from '../../shared/api';
import styles from './Rounds.module.css';
import { interviewTypeLabel } from './format';
import { applicationsQueryKey, roundsQueryKey } from './queries';
import { RoundTags } from './RoundTags';

const typeOptions = INTERVIEW_TYPES.map((type) => ({
  value: type,
  label: interviewTypeLabel(type),
}));

/** A Round as the list names it: its place in the application's process. */
const roundName = (position: number) => `Round ${position}`;

/**
 * Deletes a Round. One that is already gone (deleted in another tab) is the outcome the user asked
 * for, so its 404 counts as done: the list refetches and the dialog closes.
 */
async function deleteRound({ applicationId, id }: Round) {
  try {
    await api.deleteRound(applicationId, id);
  } catch (error) {
    if (error instanceof ApiError && error.cause instanceof RoundNotFound) return;

    throw error;
  }
}

/** An application's Rounds, in the order they were added, with a form to add one. */
export function Rounds({ applicationId }: { applicationId: string }) {
  const queryClient = useQueryClient();
  const headingId = useId();

  const rounds = useQuery({
    queryKey: roundsQueryKey(applicationId),
    queryFn: () => api.listRounds(applicationId),
  });

  const [interviewType, setInterviewType] = useState<InterviewType>(INTERVIEW_TYPES[0]);

  // Adding the first Round can move the application to interviewing, so the application and the
  // list of applications are asked again along with the Rounds.
  const refresh = () => queryClient.invalidateQueries({ queryKey: applicationsQueryKey });

  const add = useMutation({
    mutationFn: () => api.createRound(applicationId, { interviewType }),
    onSuccess: refresh,
  });

  // The Round being deleted stays set while the dialog closes, so its text doesn't vanish mid-fade.
  const [toDelete, setToDelete] = useState<{ round: Round; position: number }>();
  const [confirming, setConfirming] = useState(false);

  const remove = useMutation({
    mutationFn: deleteRound,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: roundsQueryKey(applicationId) }),
  });

  const askToDelete = (round: Round, position: number) => {
    remove.reset();
    setToDelete({ round, position });
    setConfirming(true);
  };

  const closeDialog = () => {
    // Closing mid-request would hide a failure, so the dialog waits for the answer.
    if (!remove.isPending) setConfirming(false);
  };

  return (
    <section className={styles.rounds} aria-labelledby={headingId}>
      <h3 id={headingId}>Rounds</h3>
      {rounds.isPending && <p>Loading rounds…</p>}
      {rounds.isError && <Alert tone="error">{rounds.error.message}</Alert>}
      {rounds.data?.length === 0 && <p>No rounds yet.</p>}
      {rounds.data && rounds.data.length > 0 && (
        <ol className={styles.list} aria-label="Rounds">
          {rounds.data.map((round, i) => (
            <li key={round.id} className={styles.round}>
              <div className={styles.heading}>
                <span>
                  {roundName(i + 1)}: {interviewTypeLabel(round.interviewType)}
                </span>
                <Button
                  variant="text"
                  aria-label={`Delete ${roundName(i + 1)}`}
                  onClick={() => askToDelete(round, i + 1)}
                >
                  Delete
                </Button>
              </div>
              <RoundTags round={round} name={roundName(i + 1)} />
            </li>
          ))}
        </ol>
      )}
      <form
        className={styles.add}
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <Select
          label="Interview type"
          options={typeOptions}
          value={interviewType}
          onValueChange={setInterviewType}
        />
        <Button type="submit" variant="outlined" disabled={add.isPending}>
          Add round
        </Button>
      </form>
      {add.isError && <Alert tone="error">{add.error.message}</Alert>}
      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        title="Delete round?"
        description={
          toDelete && (
            <>
              {roundName(toDelete.position)} ({interviewTypeLabel(toDelete.round.interviewType)})
              will be deleted. You can’t undo this.
            </>
          )
        }
        actions={
          <>
            <Button variant="text" disabled={remove.isPending} onClick={closeDialog}>
              Cancel
            </Button>
            <Button
              disabled={remove.isPending}
              onClick={() => {
                if (toDelete) {
                  remove.mutate(toDelete.round, { onSuccess: () => setConfirming(false) });
                }
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        {remove.error && <Alert tone="error">{remove.error.message}</Alert>}
      </Dialog>
    </section>
  );
}
