import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  APPLICATION_STATUSES,
  type Application,
  type ApplicationStatus,
} from '@roundtable/contract';
import { Alert, Button, Dialog, Select } from '../../design-system';
import { api } from '../../shared/api';
import styles from './ApplicationsTable.module.css';
import { applicationsQueryKey } from './queries';

const formatDate = (date: Date) => date.toLocaleDateString();

const statusOptions = APPLICATION_STATUSES.map((status) => ({
  value: status,
  label: status.charAt(0).toUpperCase() + status.slice(1),
}));

export function ApplicationsTable() {
  const queryClient = useQueryClient();
  const applications = useQuery({ queryKey: applicationsQueryKey, queryFn: api.listApplications });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: applicationsQueryKey });

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: ApplicationStatus }) =>
      api.updateApplication(id, { status }),
    onSuccess: invalidate,
  });

  // The row being deleted stays set while the dialog closes, so its text doesn't vanish mid-fade.
  const [toDelete, setToDelete] = useState<Application>();
  const [confirming, setConfirming] = useState(false);
  // Returning invalidate's promise keeps the mutation pending until the list has refetched, so the
  // row is gone by the time the dialog closes.
  const remove = useMutation({ mutationFn: api.deleteApplication, onSuccess: invalidate });

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
      {updateStatus.error && <Alert tone="error">{updateStatus.error.message}</Alert>}
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
                    options={statusOptions}
                    value={a.status}
                    onValueChange={(status) => updateStatus.mutate({ id: a.id, status })}
                  />
                </td>
                <td>{formatDate(a.createdAt)}</td>
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
            <Button variant="text" onClick={closeDialog}>
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
