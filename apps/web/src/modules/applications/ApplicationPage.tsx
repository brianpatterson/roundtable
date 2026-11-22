import { useQuery } from '@tanstack/react-query';
import { ApplicationNotFound, isApplicationId } from '@roundtable/contract';
import { ApiError } from '@roundtable/contract/client';
import { Alert, Link } from '../../design-system';
import { api } from '../../shared/api';
import styles from './ApplicationPage.module.css';
import { appliedLabel, statusLabel } from './format';
import { applicationQueryKey } from './queries';
import { Rounds } from './Rounds';

/**
 * One application, or null if there is none with that id for this user. A missing id and another
 * user's both answer ApplicationNotFound, so the page can't tell them apart either. It's an
 * answer, not a failure: nothing to retry.
 */
async function getApplication(id: string) {
  try {
    return await api.getApplication(id);
  } catch (error) {
    if (error instanceof ApiError && error.cause instanceof ApplicationNotFound) return null;

    throw error;
  }
}

const backLink = <Link to="/">Back to my applications</Link>;

/**
 * An application's own page (ADR-0049). The shell passes the id from the URL. A malformed id is
 * never sent to the server: it shows the same "not found" as a missing one.
 */
export function ApplicationPage({ applicationId }: { applicationId: string }) {
  const wellFormed = isApplicationId(applicationId);

  const application = useQuery({
    queryKey: applicationQueryKey(applicationId),
    queryFn: () => getApplication(applicationId),
    enabled: wellFormed,
  });

  if (!wellFormed || application.data === null) {
    return (
      <section className={styles.page}>
        <h2>Application not found</h2>
        <p>It may have been deleted, or the link may be wrong.</p>
        <p>{backLink}</p>
      </section>
    );
  }

  if (application.isPending) return <p>Loading…</p>;

  if (application.isError) {
    return (
      <section className={styles.page}>
        <Alert tone="error">{application.error.message}</Alert>
        <p>{backLink}</p>
      </section>
    );
  }

  const { company, jobTitle, jobUrl, status, appliedAt } = application.data;

  return (
    <section className={styles.page}>
      <p>{backLink}</p>
      <h2>{company}</h2>
      <dl className={styles.fields}>
        <dt>Job title</dt>
        <dd>{jobTitle}</dd>
        {jobUrl && (
          <>
            <dt>Job link</dt>
            <dd>
              <a href={jobUrl} target="_blank" rel="noreferrer">
                {jobUrl}
              </a>
            </dd>
          </>
        )}
        <dt>Status</dt>
        <dd>{statusLabel(status)}</dd>
        <dt>Applied</dt>
        <dd>{appliedLabel(appliedAt)}</dd>
      </dl>
      <Rounds applicationId={applicationId} />
    </section>
  );
}
