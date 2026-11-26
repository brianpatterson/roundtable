import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import {
  MAX_PREP_NOTES,
  MAX_PREP_TASKS,
  prepProgress,
  type CreatePrepTask,
  type Persona,
  type Round,
  type Skill,
} from '@roundtable/contract';
import { Alert, Button, Dialog, Link, Select, TextArea, TextField } from '../../design-system';
import { usePersonas, useSkills } from '../personas';
import { api } from '../../shared/api';
import { NO_SKILL, skillGroups, skillIdOf, titleProblem, useRefreshPrep } from './prep';
import { PrepTaskItem } from './PrepTaskItem';
import styles from './Rounds.module.css';

interface RoundPrepProps {
  round: Round;
  name: string;
  /** The application's Persona, whose Skills the Skill pickers list first. */
  personaId: string | null;
}

/**
 * A Round's Prep (GLOSSARY.md): its notes, and its checklist of prep tasks with how many are done,
 * each optionally naming a Skill from the skill library, which the personas module owns. The
 * Persona is found in `usePersonas()` by id, so a Skill ticked on its page shows here at once.
 */
export function RoundPrep({ round, name, personaId }: RoundPrepProps) {
  const skills = useSkills();
  const personas = usePersonas();
  const persona = personas.data?.find((p) => p.id === personaId);
  const refresh = useRefreshPrep(round.applicationId);
  const progress = prepProgress(round);
  const progressLabel = progress && `${progress.done} of ${progress.total} done`;

  // Named with the Round too, so each Round's Prep section has a name of its own.
  return (
    <section
      className={styles.prep}
      aria-label={`${name} prep${progressLabel ? `, ${progressLabel}` : ''}`}
    >
      <h4 className={styles.prepHeading}>
        Prep
        {progressLabel && (
          <>
            {' '}
            <span className={styles.progress}>{progressLabel}</span>
          </>
        )}
      </h4>
      <PrepNotes round={round} name={name} refresh={refresh} />
      {round.prepTasks.length > 0 && (
        <ul className={styles.tasks} aria-label="Prep tasks">
          {round.prepTasks.map((task) => (
            <PrepTaskItem
              key={task.id}
              round={round}
              task={task}
              skills={skills.data}
              persona={persona}
            />
          ))}
        </ul>
      )}
      {skills.isError && <Alert tone="error">{skills.error.message}</Alert>}
      <AddPrepTask
        round={round}
        name={name}
        refresh={refresh}
        skills={skills.data}
        persona={persona}
      />
    </section>
  );
}

interface PartProps {
  round: Round;
  name: string;
  refresh: ReturnType<typeof useRefreshPrep>;
}

interface AddPrepTaskProps extends PartProps {
  /** The skill library from `useSkills()`; undefined until it loads. */
  skills: readonly Skill[] | undefined;
  persona: Persona | undefined;
}

/** The Round's Prep notes, with their line breaks, and a dialog to write or clear them. */
function PrepNotes({ round, name, refresh }: PartProps) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState('');

  const save = useMutation({
    mutationFn: (value: string) =>
      api.setPrepNotes(round.applicationId, round.id, value.trim() ? value : null),
    onSuccess: refresh,
  });

  const openDialog = () => {
    save.reset();
    setNotes(round.prepNotes ?? '');
    setOpen(true);
  };

  // Closing mid-request would hide a failure, so the dialog waits for the answer.
  const close = () => {
    if (!save.isPending) setOpen(false);
  };

  const written = round.prepNotes !== null;
  const tooLong = notes.length > MAX_PREP_NOTES;

  return (
    <div className={styles.rating}>
      <div className={styles.ratingLine}>
        {!written && <span>No notes yet</span>}
        <Button
          variant="text"
          aria-label={`${written ? 'Edit' : 'Add'} notes for ${name}`}
          onClick={openDialog}
        >
          {written ? 'Edit notes' : 'Add notes'}
        </Button>
      </div>
      {written && <p className={styles.note}>{round.prepNotes}</p>}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        title={`Prep notes for ${name}`}
        description="What to prepare, research or remember. Clear them to remove them."
        actions={
          <>
            <Button variant="text" disabled={save.isPending} onClick={close}>
              Cancel
            </Button>
            <Button
              disabled={save.isPending || tooLong}
              onClick={() => save.mutate(notes, { onSuccess: () => setOpen(false) })}
            >
              Save
            </Button>
          </>
        }
      >
        <TextArea
          label="Prep notes"
          description={`Up to ${MAX_PREP_NOTES} characters.`}
          rows={8}
          value={notes}
          error={
            tooLong
              ? `The notes are ${notes.length} characters; they can be at most ${MAX_PREP_NOTES}.`
              : null
          }
          onChange={(e) => setNotes(e.target.value)}
        />
        {save.error && <Alert tone="error">{save.error.message}</Alert>}
      </Dialog>
    </div>
  );
}

/**
 * The form that adds a prep task, last and not done. A blank or too-long title is refused here;
 * at `MAX_PREP_TASKS` the form is disabled and says why.
 */
function AddPrepTask({ round, name, refresh, skills, persona }: AddPrepTaskProps) {
  const [title, setTitle] = useState('');
  const [choice, setChoice] = useState(NO_SKILL);
  const [problem, setProblem] = useState<string>();

  const add = useMutation({
    mutationFn: (task: CreatePrepTask) => api.addPrepTask(round.applicationId, round.id, task),
    onSuccess: () => {
      setTitle('');
      setChoice(NO_SKILL);

      return refresh();
    },
  });

  const full = round.prepTasks.length >= MAX_PREP_TASKS;

  return (
    <form
      className={styles.addTask}
      aria-label={`Add a prep task to ${name}`}
      onSubmit={(e) => {
        e.preventDefault();

        const why = titleProblem(title);

        setProblem(why);

        if (!why) add.mutate({ title, skillId: skillIdOf(choice) });
      }}
    >
      <div className={styles.add}>
        <TextField
          label="Task"
          value={title}
          disabled={full}
          error={problem ?? add.error?.message}
          onChange={(e) => {
            setProblem(undefined);
            add.reset();
            setTitle(e.target.value);
          }}
        />
        <Select
          label="Skill"
          groups={skillGroups(skills ?? [], persona)}
          value={choice}
          disabled={full}
          onValueChange={setChoice}
        />
        <Button type="submit" variant="text" disabled={full || add.isPending}>
          Add task
        </Button>
      </div>
      {full ? (
        <p className={styles.hint}>
          This round has {MAX_PREP_TASKS} prep tasks, the most it can have. Delete one to add
          another.
        </p>
      ) : (
        <p className={styles.hint}>
          Skills come from your skill library: <Link to="/skills">manage your skills</Link>.
        </p>
      )}
    </form>
  );
}
