import { useId, useState } from 'react';
import { MAX_PERSONAS, type Persona } from '@roundtable/contract';
import { Alert, Button, Link } from '../../design-system';
import { AddPersonaForm } from './AddPersonaForm';
import styles from './Personas.module.css';
import { usePersonas } from './queries';

/** How many Skills a Persona has, archived ones included, in words. */
export function skillCount(persona: Persona) {
  const count = persona.skillIds.length;

  return count === 1 ? '1 skill' : `${count} skills`;
}

/** One Persona in a list: its name, linking to its page, and how many Skills it has. */
function PersonaItem({ persona }: { readonly persona: Persona }) {
  return (
    <li className={styles.persona}>
      <span className={styles.name}>
        <Link to="/personas/$personaId" params={{ personaId: persona.id }}>
          {persona.name}
        </Link>
      </span>
      <span>{skillCount(persona)}</span>
    </li>
  );
}

/**
 * The Personas page: the user's Personas (GLOSSARY.md), with a form to add one. Each links to its
 * own page, where it's renamed, archived and given its Skills. Archived Personas sit in a
 * collapsed section below the active ones, as on the Skills page.
 */
export function PersonasPage() {
  const personas = usePersonas();
  const archivedId = useId();
  const [showArchived, setShowArchived] = useState(false);

  const active = personas.data?.filter((persona) => persona.archivedAt === null) ?? [];
  const archived = personas.data?.filter((persona) => persona.archivedAt !== null) ?? [];

  return (
    <section className={styles.page} aria-labelledby="personas-heading">
      <h2 id="personas-heading">Personas</h2>
      {personas.isPending && <p>Loading…</p>}
      {personas.isError && <Alert tone="error">{personas.error.message}</Alert>}
      {personas.data?.length === 0 && (
        <p>
          No personas yet. A persona is one way you present yourself for a kind of job, such as
          backend engineer or engineering manager. Give each the skills that kind of job needs, so
          you know what to practice for the applications you make as it.
        </p>
      )}
      {personas.data && <AddPersonaForm full={personas.data.length >= MAX_PERSONAS} />}
      {active.length > 0 && (
        <ul className={styles.list} aria-label="Personas">
          {active.map((persona) => (
            <PersonaItem key={persona.id} persona={persona} />
          ))}
        </ul>
      )}
      {archived.length > 0 && (
        <div className={styles.archived}>
          <Button
            variant="text"
            aria-expanded={showArchived}
            aria-controls={archivedId}
            onClick={() => setShowArchived((shown) => !shown)}
          >
            Archived ({archived.length})
          </Button>
          <ul id={archivedId} className={styles.list} aria-label="Archived" hidden={!showArchived}>
            {archived.map((persona) => (
              <PersonaItem key={persona.id} persona={persona} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
