import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import {
  INTERVIEW_TYPES,
  RoundNotFound,
  type InterviewType,
  type Round,
  type RoundSchedule,
} from '@roundtable/contract';
import { ApiError } from '@roundtable/contract/client';
import { Alert, Button, Dialog, Select } from '../../design-system';
import { api } from '../../shared/api';
import styles from './Rounds.module.css';
import {
  EMPTY_SCHEDULE,
  ScheduleFields,
  draftOf,
  scheduleOf,
  type ScheduleDraft,
} from './Schedule';
import {
  inLocalOrder,
  inUserTimeZone,
  interviewTypeLabel,
  roundNames,
  scheduleLabel,
} from './format';
import { applicationsQueryKey, roundsQueryKey } from './queries';
import { RoundOutcome } from './RoundOutcome';
import { RoundRating } from './RoundRating';
import { RoundTags } from './RoundTags';

const typeOptions = INTERVIEW_TYPES.map((type) => ({
  value: type,
  label: interviewTypeLabel(type),
}));

/** A Round with the name the list gives it (`Coding 2`), for a dialog about it. */
interface NamedRound {
  round: Round;
  name: string;
}

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

/**
 * An application's Rounds, dated ones first in date order and the rest as they were added (the
 * server's order), with a form to add one and a dialog to change one's schedule.
 */
export function Rounds({ applicationId }: { applicationId: string }) {
  const queryClient = useQueryClient();
  const headingId = useId();

  const rounds = useQuery({
    queryKey: roundsQueryKey(applicationId),
    queryFn: () => api.listRounds(applicationId),
    select: inLocalOrder,
  });

  const [interviewType, setInterviewType] = useState<InterviewType>(INTERVIEW_TYPES[0]);
  const [schedule, setSchedule] = useState<ScheduleDraft>(EMPTY_SCHEDULE);
  const [addError, setAddError] = useState<string>();

  // Adding the first Round can move the application to interviewing, so the application and the
  // list of applications are asked again along with the Rounds, whose Outcomes it can infer.
  const refresh = () => queryClient.invalidateQueries({ queryKey: applicationsQueryKey });

  const add = useMutation({
    mutationFn: (when: RoundSchedule) =>
      api.createRound(applicationId, { interviewType, ...when, ...inUserTimeZone() }),
    onSuccess: () => {
      setSchedule(EMPTY_SCHEDULE);

      return refresh();
    },
  });

  const refreshRounds = () =>
    queryClient.invalidateQueries({ queryKey: roundsQueryKey(applicationId) });

  // The Round being deleted stays set while the dialog closes, so its text doesn't vanish mid-fade.
  const [toDelete, setToDelete] = useState<NamedRound>();
  const [confirming, setConfirming] = useState(false);

  const remove = useMutation({ mutationFn: deleteRound, onSuccess: refreshRounds });

  const askToDelete = (named: NamedRound) => {
    remove.reset();
    setToDelete(named);
    setConfirming(true);
  };

  const closeDialog = () => {
    // Closing mid-request would hide a failure, so the dialog waits for the answer.
    if (!remove.isPending) setConfirming(false);
  };

  // The same for the Round whose schedule is being edited.
  const [toEdit, setToEdit] = useState<NamedRound>();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ScheduleDraft>(EMPTY_SCHEDULE);
  const [editError, setEditError] = useState<string>();

  const reschedule = useMutation({
    mutationFn: ({ round, when }: { round: Round; when: RoundSchedule }) =>
      api.scheduleRound(round.applicationId, round.id, when),
    onSuccess: refreshRounds,
  });

  const askToEdit = (named: NamedRound) => {
    reschedule.reset();
    setEditError(undefined);
    setToEdit(named);
    setDraft(draftOf(named.round));
    setEditing(true);
  };

  const closeEditor = () => {
    if (!reschedule.isPending) setEditing(false);
  };

  const save = () => {
    const result = scheduleOf(draft);

    setEditError(result.ok ? undefined : result.error);

    if (result.ok && toEdit) {
      reschedule.mutate(
        { round: toEdit.round, when: result.schedule },
        { onSuccess: () => setEditing(false) },
      );
    }
  };

  const editMessage = editError ?? reschedule.error?.message;

  const names = rounds.data ? roundNames(rounds.data) : [];

  return (
    <section className={styles.rounds} aria-labelledby={headingId}>
      <h3 id={headingId}>Rounds</h3>
      {rounds.isPending && <p>Loading rounds…</p>}
      {rounds.isError && <Alert tone="error">{rounds.error.message}</Alert>}
      {rounds.data?.length === 0 && <p>No rounds yet.</p>}
      {rounds.data && rounds.data.length > 0 && (
        <ol className={styles.list} aria-label="Rounds">
          {rounds.data.map((round, i) => {
            const name = names[i] ?? '';

            return (
              <li key={round.id} className={styles.round}>
                <div className={styles.heading}>
                  <span className={styles.summary}>
                    <span>{name}</span>
                    <span className={styles.when}>{scheduleLabel(round)}</span>
                  </span>
                  <span className={styles.actions}>
                    <Button
                      variant="text"
                      aria-label={`Edit schedule of ${name}`}
                      onClick={() => askToEdit({ round, name })}
                    >
                      Edit schedule
                    </Button>
                    <Button
                      variant="text"
                      aria-label={`Delete ${name}`}
                      onClick={() => askToDelete({ round, name })}
                    >
                      Delete
                    </Button>
                  </span>
                </div>
                <RoundOutcome round={round} name={name} />
                <RoundRating round={round} name={name} />
                <RoundTags round={round} name={name} />
              </li>
            );
          })}
        </ol>
      )}
      <form
        className={styles.add}
        aria-label="Add a round"
        onSubmit={(e) => {
          e.preventDefault();

          const result = scheduleOf(schedule);

          setAddError(result.ok ? undefined : result.error);

          if (result.ok) add.mutate(result.schedule);
        }}
      >
        <Select
          label="Interview type"
          options={typeOptions}
          value={interviewType}
          onValueChange={setInterviewType}
        />
        <ScheduleFields draft={schedule} onChange={setSchedule} />
        <Button type="submit" variant="outlined" disabled={add.isPending}>
          Add round
        </Button>
      </form>
      {addError && <Alert tone="error">{addError}</Alert>}
      {!addError && add.isError && <Alert tone="error">{add.error.message}</Alert>}
      <Dialog
        open={editing}
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
        title={toEdit ? `Schedule ${toEdit.name}` : 'Schedule'}
        description="When it happens, when it’s due, or not scheduled yet."
        actions={
          <>
            <Button variant="text" disabled={reschedule.isPending} onClick={closeEditor}>
              Cancel
            </Button>
            <Button disabled={reschedule.isPending} onClick={save}>
              Save
            </Button>
          </>
        }
      >
        <ScheduleFields draft={draft} onChange={setDraft} />
        {editMessage && <Alert tone="error">{editMessage}</Alert>}
      </Dialog>
      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        title="Delete round?"
        description={toDelete && <>{toDelete.name} will be deleted. You can’t undo this.</>}
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
