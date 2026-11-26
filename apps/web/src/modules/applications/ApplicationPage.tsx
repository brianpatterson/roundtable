import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApplicationNotFound, isApplicationId, type Application } from '@roundtable/contract';
import { ApiError } from '@roundtable/contract/client';
import { Alert, Link, Select, useSnackbar, type SelectOption } from '../../design-system';
import { api } from '../../shared/api';
import { usePersonas } from '../personas';
import styles from './ApplicationPage.module.css';
import { appliedLabel, statusLabel } from './format';
import { personaChoice, personaIdOf, personaOptions } from './persona';
import { applicationQueryKey, applicationsQueryKey } from './queries';
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

const backLink = <Link to="/applications">Back to my applications</Link>;

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
        <dt>Persona</dt>
        <dd className={styles.persona}>
          <PersonaField application={application.data} />
        </dd>
      </dl>
      <Rounds applicationId={applicationId} />
    </section>
  );
}

/**
 * The Persona an Application is made as, and the picker that changes it. Names come from
 * `usePersonas()` by id, so a Persona renamed elsewhere shows its new name here. While a change is
 * saved the picker shows it; if it fails, the picker goes back to the stored Persona.
 */
function PersonaField({ application }: { readonly application: Application }) {
  const queryClient = useQueryClient();
  const showSnackbar = useSnackbar();
  const personas = usePersonas();

  const update = useMutation({
    mutationFn: (picked: SelectOption<string>) =>
      api.updateApplication(application.id, { personaId: personaIdOf(picked.value) }),
    onSuccess: (updated, picked) => {
      queryClient.setQueryData(applicationQueryKey(application.id), updated);
      showSnackbar(
        updated.personaId === null ? 'Persona cleared.' : `Persona set to ${picked.label}.`,
        'status',
      );
    },
    meta: { errorSnackbar: true },
    // The list shows when each application was last updated. Only the list and this application,
    // not its Rounds, which a Persona doesn't change.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: applicationsQueryKey, exact: true }),
        queryClient.invalidateQueries({
          queryKey: applicationQueryKey(application.id),
          exact: true,
        }),
      ]),
  });

  if (personas.isPending) return 'Loading…';

  if (personas.isError) return personas.error.message;

  // Nothing to pick: point the way to adding a Persona instead.
  if (personas.data.length === 0 && application.personaId === null) {
    return (
      <>
        None. <Link to="/personas">Add a persona</Link>
      </>
    );
  }

  const options = personaOptions(personas.data, application.personaId);

  return (
    <Select
      label="Persona"
      hideLabel
      options={options}
      value={update.isPending ? update.variables.value : personaChoice(application.personaId)}
      onValueChange={(choice) => {
        const picked = options.find((option) => option.value === choice);

        if (picked) update.mutate(picked);
      }}
    />
  );
}
