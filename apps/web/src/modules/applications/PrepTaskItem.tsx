import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import type { Persona, PrepTask, Round, Skill } from '@roundtable/contract';
import { Alert, Button, Checkbox, Dialog, Select, TextField } from '../../design-system';
import { api } from '../../shared/api';
import { NO_SKILL, skillGroups, skillIdOf, skillLabel, titleProblem, useRefreshPrep } from './prep';
import styles from './Rounds.module.css';

interface PrepTaskItemProps {
  round: Round;
  task: PrepTask;
  /** The skill library from `useSkills()`; undefined until it loads. */
  skills: readonly Skill[] | undefined;
  /** The application's Persona, whose Skills the picker lists first. */
  persona: Persona | undefined;
}

/**
 * One prep task: a Checkbox to mark it done, the Skill it practices, and buttons to edit it in a
 * dialog or delete it.
 */
export function PrepTaskItem({ round, task, skills, persona }: PrepTaskItemProps) {
  const refresh = useRefreshPrep(round.applicationId);
  const skill = skills?.find((s) => s.id === task.skillId);

  const toggle = useMutation({
    mutationFn: (done: boolean) =>
      api.updatePrepTask(round.applicationId, round.id, task.id, { done }),
    onSuccess: refresh,
  });

  const remove = useMutation({
    mutationFn: () => api.deletePrepTask(round.applicationId, round.id, task.id),
    onSuccess: refresh,
  });

  // While a tick is saved, the box shows what the user asked for.
  const done = toggle.isPending ? toggle.variables : task.completedAt !== null;

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [choice, setChoice] = useState(NO_SKILL);
  const [problem, setProblem] = useState<string>();

  const edit = useMutation({
    mutationFn: () =>
      api.updatePrepTask(round.applicationId, round.id, task.id, {
        title,
        skillId: skillIdOf(choice),
      }),
    onSuccess: refresh,
  });

  const openDialog = () => {
    edit.reset();
    setProblem(undefined);
    setTitle(task.title);
    setChoice(task.skillId ?? NO_SKILL);
    setOpen(true);
  };

  // Closing mid-request would hide a failure, so the dialog waits for the answer.
  const close = () => {
    if (!edit.isPending) setOpen(false);
  };

  const save = () => {
    const why = titleProblem(title);

    setProblem(why);

    if (!why) edit.mutate(undefined, { onSuccess: () => setOpen(false) });
  };

  const error = toggle.error ?? remove.error;

  return (
    <li className={styles.task}>
      <div className={styles.taskLine}>
        <div className={done ? styles.done : styles.todo}>
          <Checkbox
            label={task.title}
            checked={done}
            disabled={toggle.isPending || remove.isPending}
            onCheckedChange={(next) => {
              remove.reset();
              toggle.mutate(next);
            }}
          />
        </div>
        {skill && <span className={styles.skill}>{skillLabel(skill)}</span>}
        <span className={styles.actions}>
          <Button variant="text" aria-label={`Edit task ${task.title}`} onClick={openDialog}>
            Edit
          </Button>
          <Button
            variant="text"
            aria-label={`Delete task ${task.title}`}
            disabled={remove.isPending}
            onClick={() => {
              toggle.reset();
              remove.mutate();
            }}
          >
            Delete
          </Button>
        </span>
      </div>
      {error && <Alert tone="error">{error.message}</Alert>}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        title="Edit prep task"
        description="What to do, and the Skill it practices."
        actions={
          <>
            <Button variant="text" disabled={edit.isPending} onClick={close}>
              Cancel
            </Button>
            <Button disabled={edit.isPending} onClick={save}>
              Save
            </Button>
          </>
        }
      >
        <TextField
          label="Title"
          value={title}
          error={problem}
          onChange={(e) => {
            setProblem(undefined);
            setTitle(e.target.value);
          }}
        />
        <Select
          label="Skill"
          groups={skillGroups(skills ?? [], persona, task.skillId)}
          value={choice}
          onValueChange={setChoice}
        />
        {edit.error && <Alert tone="error">{edit.error.message}</Alert>}
      </Dialog>
    </li>
  );
}
