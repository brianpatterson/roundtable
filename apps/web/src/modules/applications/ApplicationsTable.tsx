import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  ApplicationNotFound,
  SETTABLE_APPLICATION_STATUSES,
  type Application,
  type ApplicationStatus,
  type SettableApplicationStatus,
} from '@roundtable/contract';
import { ApiError } from '@roundtable/contract/client';
import { Alert, Button, Dialog, Select } from '../../design-system';
import { api } from '../../shared/api';
import styles from './ApplicationsTable.module.css';
import { applicationsQueryKey } from './queries';

const formatDate = (date: Date) => date.toLocaleDateString();

/**
 * Deletes an application. One that is already gone (deleted in another tab) is the outcome the
 * user asked for, so its 404 counts as done: the list refetches and the dialog closes.
 */
async function deleteApplication(id: string) {
  try {
    await api.deleteApplication(id);
  } catch (error) {
    if (error instanceof ApiError && error.cause instanceof ApplicationNotFound) return;

    throw error;
  }
}

const statusOption = <Status extends ApplicationStatus>(status: Status) => ({
  value: status,
  label: status.charAt(0).toUpperCase() + status.slice(1),
});

const settableOptions = SETTABLE_APPLICATION_STATUSES.map(statusOption);

const isSettable = (status: ApplicationStatus): status is SettableApplicationStatus =>
  settableOptions.some((option) => option.value === status);

/**
 * The statuses a row offers. A `saved` row (written by the next release, then rolled back to this
 * one) shows its status too, so the select isn't blank, but can't be picked back (ADR-0045).
 */
const optionsFor = (status: ApplicationStatus) =>
  isSettable(status) ? settableOptions : [statusOption(status), ...settableOptions];

export function ApplicationsTable() {
  const queryClient = useQueryClient();
  const applications = useQuery({ queryKey: applicationsQueryKey, queryFn: api.listApplications });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: applicationsQueryKey });

  // A failure goes in a snackbar (the shell shows it), so the table doesn't move. The list is asked
  // again either way, so each row's select shows the status the server has. Each attempt is its
  // own mutation, so two failures in a row show two messages.
  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: SettableApplicationStatus }) =>
      api.updateApplication(id, { status }),
    meta: { errorSnackbar: true },
    onSettled: invalidate,
  });

  // The row being deleted stays set while the dialog closes, so its text doesn't vanish mid-fade.
  const [toDelete, setToDelete] = useState<Application>();
  const [confirming, setConfirming] = useState(false);
  // Returning invalidate's promise keeps the mutation pending until the list has refetched, so the
  // row is gone by the time the dialog closes.
  const remove = useMutation({ mutationFn: deleteApplication, onSuccess: invalidate });

  const askToDelete = (application: Application) => {
    remove.reset();
    setToDelete(application);
    setConfirming(true);
  };

  const closeDialog = () => {
    // Closing mid-request would hide a failure, so the dialog waits for the answer.
    if (!remove.isPending) setConfirming(false);
  };

  if (applications.isPending) return <p>Loading…</p>;

  if (applications.isError) return <Alert tone="error">{applications.error.message}</Alert>;

  if (applications.data.length === 0) return <p>No applications yet. Add your first one above.</p>;

  return (
    <>
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Company</th>
              <th>Job title</th>
              <th>Status</th>
              <th>Applied</th>
              <th>Last updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {applications.data.map((a) => (
              <tr key={a.id}>
                <td>{a.company}</td>
                <td>
                  {a.jobUrl ? (
                    <a href={a.jobUrl} target="_blank" rel="noreferrer">
                      {a.jobTitle}
                    </a>
                  ) : (
                    a.jobTitle
                  )}
                </td>
                <td>
                  <Select
                    label={`Status for ${a.company}`}
                    hideLabel
                    options={optionsFor(a.status)}
                    value={a.status}
                    onValueChange={(status) => {
                      if (isSettable(status)) updateStatus.mutate({ id: a.id, status });
                    }}
                  />
                </td>
                <td>{a.appliedAt ? formatDate(a.appliedAt) : 'Not sent'}</td>
                <td>{formatDate(a.updatedAt)}</td>
                <td>
                  <Button variant="text" onClick={() => askToDelete(a)}>
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        title="Delete application?"
        description={
          toDelete && (
            <>
              {toDelete.company} – {toDelete.jobTitle} will be deleted. You can’t undo this.
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
                if (toDelete) remove.mutate(toDelete.id, { onSuccess: () => setConfirming(false) });
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        {remove.error && <Alert tone="error">{remove.error.message}</Alert>}
      </Dialog>
    </>
  );
}
