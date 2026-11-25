import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Alert, Link } from '../../design-system';
import { api } from '../../shared/api';
import styles from './AgendaPage.module.css';
import {
  agendaTime,
  byDay,
  dayHeading,
  inUserTimeZone,
  interviewTypeLabel,
  timeLeft,
  userTimeZone,
} from './format';
import { agendaQueryKey } from './queries';

const MS_PER_MINUTE = 60_000;

/** The time now, updated every minute while the page is open, so time left counts down. */
function useNow() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), MS_PER_MINUTE);

    return () => clearInterval(timer);
  }, []);

  return now;
}

/**
 * The Agenda (ADR-0070), the home page: the user's upcoming Rounds across their open
 * applications, grouped by day in the API's order, each with how long is left.
 */
export function AgendaPage() {
  const now = useNow();
  const timeZone = userTimeZone();

  const agenda = useQuery({
    queryKey: agendaQueryKey,
    queryFn: () => api.agenda(inUserTimeZone().timeZone),
  });

  return (
    <section className={styles.page} aria-labelledby="agenda-heading">
      <h2 id="agenda-heading">Agenda</h2>
      {agenda.isPending && <p>Loading…</p>}
      {agenda.isError && <Alert tone="error">{agenda.error.message}</Alert>}
      {agenda.data?.length === 0 && (
        <p>
          Nothing coming up. Rounds you add to an application show here.{' '}
          <Link to="/applications">Go to my applications</Link>
        </p>
      )}
      {agenda.data &&
        byDay(agenda.data, timeZone).map(({ day, rounds }) => {
          const headingId = `agenda-${day ?? 'unscheduled'}`;

          return (
            <section key={headingId} className={styles.day} aria-labelledby={headingId}>
              <h3 id={headingId}>{dayHeading(day, now, timeZone)}</h3>
              <ul className={styles.rounds}>
                {rounds.map((round) => (
                  <li key={round.id} className={styles.round}>
                    <span className={styles.when}>
                      {round.startsAt ? (
                        <time dateTime={round.startsAt.toISOString()}>{agendaTime(round)}</time>
                      ) : (
                        agendaTime(round)
                      )}
                    </span>
                    <span className={styles.left}>{timeLeft(round, now, timeZone)}</span>
                    <span className={styles.what}>
                      <Link
                        to="/applications/$applicationId"
                        params={{ applicationId: round.applicationId }}
                      >
                        {round.company} – {round.jobTitle}
                      </Link>
                      <span>{interviewTypeLabel(round.interviewType)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
    </section>
  );
}
