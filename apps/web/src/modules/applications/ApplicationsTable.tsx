import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { APPLICATION_STATUSES, type ApplicationStatus } from '@roundtable/contract';
import { Alert, Button, Select } from '../../design-system';
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

  const remove = useMutation({ mutationFn: api.deleteApplication, onSuccess: invalidate });

  if (applications.isPending) return <p>Loading…</p>;

  if (applications.isError) return <Alert tone="error">{applications.error.message}</Alert>;

  if (applications.data.length === 0) return <p>No applications yet. Add your first one above.</p>;

  const mutationError = updateStatus.error ?? remove.error;

  return (
    <>
      {mutationError && <Alert tone="error">{mutationError.message}</Alert>}
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
                  <Button
                    variant="text"
                    onClick={() => {
                      if (confirm(`Delete ${a.company} – ${a.jobTitle}?`)) remove.mutate(a.id);
                    }}
                  >
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
