import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import {
  MAX_PERSONA_NAME,
  MAX_PERSONA_SKILLS,
  isPersonaId,
  type Persona,
  type Skill,
} from '@roundtable/contract';
import { Alert, Button, Checkbox, Dialog, Link, TextField, useSnackbar } from '../../design-system';
import { api } from '../../shared/api';
import { personaNameProblem } from './AddPersonaForm';
import styles from './Personas.module.css';
import { personaListQueryKey, usePersonas, useSkills } from './queries';

// Exact, or the router would mark it as the current page on every page below /personas.
const backLink = (
  <Link to="/personas" activeOptions={{ exact: true }}>
    Back to my personas
  </Link>
);

/**
 * A Persona's own page: its name, Rename and Archive (or Restore), and its Skills as checkboxes.
 * The shell passes the id from the URL. The Persona is found in `usePersonas()`: there's no
 * `GET /api/personas/:id`. A malformed id, a missing one and another user's all show "not found".
 */
export function PersonaPage({ personaId }: { readonly personaId: string }) {
  const personas = usePersonas();
  const persona = personas.data?.find((p) => p.id === personaId);

  if (!isPersonaId(personaId) || (personas.data && !persona)) {
    return (
      <section className={styles.page}>
        <h2>Persona not found</h2>
        <p>The link may be wrong, or the persona may belong to another account.</p>
        <p>{backLink}</p>
      </section>
    );
  }

  if (personas.isError) {
    return (
      <section className={styles.page}>
        <Alert tone="error">{personas.error.message}</Alert>
        <p>{backLink}</p>
      </section>
    );
  }

  if (!persona) return <p>Loading…</p>;

  return <PersonaDetails persona={persona} />;
}

function PersonaDetails({ persona }: { readonly persona: Persona }) {
  const queryClient = useQueryClient();
  const showSnackbar = useSnackbar();
  const headingId = useId();
  const archived = persona.archivedAt !== null;
  const refresh = () => queryClient.invalidateQueries({ queryKey: personaListQueryKey });

  // Archive and Restore swap one button for the other, so focus moves to the new one once the
  // page has changed. Counts the moves asked for; each new one runs the effect once.
  const archiveButtonRef = useRef<HTMLButtonElement>(null);
  const [focusMoves, setFocusMoves] = useState(0);

  useEffect(() => {
    if (focusMoves > 0) archiveButtonRef.current?.focus();
  }, [focusMoves]);

  const setArchived = useMutation({
    mutationFn: (archive: boolean) => api.updatePersona(persona.id, { archived: archive }),
    onSuccess: async (updated, archive) => {
      await refresh();
      setFocusMoves((moves) => moves + 1);
      showSnackbar(`${archive ? 'Archived' : 'Restored'} ${updated.name}.`, 'status');
    },
    meta: { errorSnackbar: true },
  });

  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState('');
  const [renameProblem, setRenameProblem] = useState<string>();

  const rename = useMutation({
    mutationFn: (name: string) => api.updatePersona(persona.id, { name }),
    onSuccess: async (updated) => {
      await refresh();
      setRenaming(false);
      showSnackbar(`Renamed to ${updated.name}.`, 'status');
    },
  });

  const askToRename = () => {
    rename.reset();
    setRenameProblem(undefined);
    setNewName(persona.name);
    setRenaming(true);
  };

  const closeRename = () => {
    // Closing mid-request would hide a failure, so the dialog waits for the answer.
    if (!rename.isPending) setRenaming(false);
  };

  const save = () => {
    const why = personaNameProblem(newName);

    setRenameProblem(why);

    if (!why) rename.mutate(newName.trim());
  };

  return (
    <section className={styles.page} aria-labelledby={headingId}>
      <p>{backLink}</p>
      <h2 id={headingId} className={styles.heading}>
        {persona.name}
      </h2>
      {archived && (
        <p>
          This persona is archived: it can't be picked for an application. Restore it to use it.
        </p>
      )}
      <div className={styles.actions}>
        <Button variant="outlined" onClick={askToRename}>
          Rename
        </Button>
        {/* Not disabled while the request runs: a disabled button loses focus, and the browser
            would drop it before it could move to Restore (or Archive). A second press waits. */}
        <Button
          ref={archiveButtonRef}
          variant="outlined"
          onClick={() => {
            if (!setArchived.isPending) setArchived.mutate(!archived);
          }}
        >
          {archived ? 'Restore' : 'Archive'}
        </Button>
      </div>
      <PersonaSkills persona={persona} />
      <Dialog
        open={renaming}
        onOpenChange={(open) => {
          if (!open) closeRename();
        }}
        title={`Rename ${persona.name}`}
        description="The new name shows wherever this persona is named."
        actions={
          <>
            <Button variant="text" disabled={rename.isPending} onClick={closeRename}>
              Cancel
            </Button>
            <Button disabled={rename.isPending} onClick={save}>
              Save
            </Button>
          </>
        }
      >
        <TextField
          label="Name"
          value={newName}
          onChange={(e) => {
            setNewName(e.target.value);
            setRenameProblem(undefined);
            rename.reset();
          }}
          maxLength={MAX_PERSONA_NAME}
          required
          error={renameProblem ?? rename.error?.message}
        />
      </Dialog>
    </section>
  );
}

/**
 * The Persona's Skills: every active Skill in the library, by name, ticked when the Persona has
 * it, and any archived Skill it has, marked so. Ticking adds a Skill and unticking removes it; the
 * box shows the change at once, and a failure puts it back and shows why in a snackbar.
 */
function PersonaSkills({ persona }: { readonly persona: Persona }) {
  const queryClient = useQueryClient();
  const skills = useSkills();
  const headingId = useId();
  // The changes sent and not yet answered: each Skill's id, and whether it's being ticked.
  const [pending, setPending] = useState<ReadonlyMap<string, boolean>>(new Map());

  const settle = (skillId: string) =>
    setPending((changes) => new Map([...changes].filter(([id]) => id !== skillId)));

  const toggle = useMutation({
    mutationFn: ({ skill, checked }: { skill: Skill; checked: boolean }) =>
      checked
        ? api.addPersonaSkill(persona.id, skill.id)
        : api.removePersonaSkill(persona.id, skill.id),
    onSuccess: async (_updated, { skill }) => {
      // The box keeps its new state until the list it's read from has it too.
      await queryClient.invalidateQueries({ queryKey: personaListQueryKey });
      settle(skill.id);
    },
    onError: (_error, { skill }) => settle(skill.id),
    meta: { errorSnackbar: true },
  });

  const has = (skillId: string) => pending.get(skillId) ?? persona.skillIds.includes(skillId);

  const onCheckedChange = (skill: Skill, checked: boolean) => {
    // One change at a time per Skill: a second would race the first's answer.
    if (pending.has(skill.id)) return;

    setPending((changes) => new Map([...changes, [skill.id, checked]]));
    toggle.mutate({ skill, checked });
  };

  if (skills.isPending) return <p>Loading…</p>;

  if (skills.isError) return <Alert tone="error">{skills.error.message}</Alert>;

  // Every active Skill, and the archived ones the Persona has, in the library's order.
  const listed = skills.data.filter(
    (skill) => skill.archivedAt === null || persona.skillIds.includes(skill.id),
  );

  const anyActive = skills.data.some((skill) => skill.archivedAt === null);
  const full = listed.filter((skill) => has(skill.id)).length >= MAX_PERSONA_SKILLS;

  return (
    <section className={styles.skills} aria-labelledby={headingId}>
      <h3 id={headingId}>Skills</h3>
      {!anyActive && (
        <p>
          Your skill library has no skills to pick from yet.{' '}
          <Link to="/skills">Add skills on the Skills page</Link>
        </p>
      )}
      {full && (
        <p>
          This persona has {MAX_PERSONA_SKILLS} skills, the most it can have. Untick one to pick
          another.
        </p>
      )}
      {listed.length > 0 && (
        <div role="group" aria-labelledby={headingId} className={styles.checkboxes}>
          {listed.map((skill) => {
            const checked = has(skill.id);

            return (
              <Checkbox
                key={skill.id}
                label={skill.archivedAt === null ? skill.name : `${skill.name} (archived)`}
                checked={checked}
                disabled={full && !checked}
                onCheckedChange={(next) => onCheckedChange(skill, next)}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
