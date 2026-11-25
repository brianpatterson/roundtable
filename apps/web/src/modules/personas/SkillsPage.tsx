import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { MAX_SKILL_NAME, MAX_SKILLS, type Skill } from '@roundtable/contract';
import { Alert, Button, Dialog, TextField, useSnackbar } from '../../design-system';
import { api } from '../../shared/api';
import { AddSkillForm } from './AddSkillForm';
import styles from './SkillsPage.module.css';
import { skillsQueryKey, useSkills } from './queries';

/**
 * The Skills page: the user's skill library (GLOSSARY.md), with a form to add a Skill, and a way
 * to rename, archive and restore each. Archived Skills sit in a collapsed section below the
 * active ones. There's no delete: prep tasks name Skills (ADR-0044 rule 3).
 */
export function SkillsPage() {
  const queryClient = useQueryClient();
  const showSnackbar = useSnackbar();
  const skills = useSkills();
  const archivedId = useId();
  const [showArchived, setShowArchived] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: skillsQueryKey });

  const setArchived = useMutation({
    mutationFn: ({ skill, archived }: { skill: Skill; archived: boolean }) =>
      api.updateSkill(skill.id, { archived }),
    onSuccess: async (skill, { archived }) => {
      await refresh();
      showSnackbar(`${archived ? 'Archived' : 'Restored'} ${skill.name}.`, 'status');
    },
    meta: { errorSnackbar: true },
  });

  // The Skill being renamed stays set while the dialog closes, so its name doesn't vanish mid-fade.
  const [toRename, setToRename] = useState<Skill>();
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState('');

  const rename = useMutation({
    mutationFn: ({ skill, name }: { skill: Skill; name: string }) =>
      api.updateSkill(skill.id, { name }),
    onSuccess: refresh,
  });

  const askToRename = (skill: Skill) => {
    rename.reset();
    setToRename(skill);
    setNewName(skill.name);
    setRenaming(true);
  };

  const closeRename = () => {
    // Closing mid-request would hide a failure, so the dialog waits for the answer.
    if (!rename.isPending) setRenaming(false);
  };

  const save = () => {
    if (toRename) {
      rename.mutate(
        { skill: toRename, name: newName.trim() },
        { onSuccess: () => setRenaming(false) },
      );
    }
  };

  const active = skills.data?.filter((skill) => skill.archivedAt === null) ?? [];
  const archived = skills.data?.filter((skill) => skill.archivedAt !== null) ?? [];

  return (
    <section className={styles.page} aria-labelledby="skills-heading">
      <h2 id="skills-heading">Skills</h2>
      {skills.isPending && <p>Loading…</p>}
      {skills.isError && <Alert tone="error">{skills.error.message}</Alert>}
      {skills.data?.length === 0 && (
        <p>
          No skills yet. A skill is something you practice for interviews, such as system design or
          telling a story about a conflict. Add the ones you work on, and your prep tasks can name
          them.
        </p>
      )}
      {skills.data && <AddSkillForm full={skills.data.length >= MAX_SKILLS} />}
      {active.length > 0 && (
        <ul className={styles.list} aria-label="Skills">
          {active.map((skill) => (
            <li key={skill.id} className={styles.skill}>
              <span className={styles.name}>{skill.name}</span>
              <span className={styles.actions}>
                <Button
                  variant="text"
                  aria-label={`Rename ${skill.name}`}
                  onClick={() => askToRename(skill)}
                >
                  Rename
                </Button>
                <Button
                  variant="text"
                  aria-label={`Archive ${skill.name}`}
                  disabled={setArchived.isPending}
                  onClick={() => setArchived.mutate({ skill, archived: true })}
                >
                  Archive
                </Button>
              </span>
            </li>
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
            {archived.map((skill) => (
              <li key={skill.id} className={styles.skill}>
                <span className={styles.name}>{skill.name}</span>
                <span className={styles.actions}>
                  <Button
                    variant="text"
                    aria-label={`Rename ${skill.name}`}
                    onClick={() => askToRename(skill)}
                  >
                    Rename
                  </Button>
                  <Button
                    variant="text"
                    aria-label={`Restore ${skill.name}`}
                    disabled={setArchived.isPending}
                    onClick={() => setArchived.mutate({ skill, archived: false })}
                  >
                    Restore
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Dialog
        open={renaming}
        onOpenChange={(open) => {
          if (!open) closeRename();
        }}
        // Stryker disable next-line StringLiteral: the title shows only while open, and toRename is set before it opens
        title={toRename ? `Rename ${toRename.name}` : 'Rename'}
        description="The new name shows wherever this skill is named."
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
            rename.reset();
          }}
          maxLength={MAX_SKILL_NAME}
          required
          error={rename.error?.message}
        />
      </Dialog>
    </section>
  );
}
