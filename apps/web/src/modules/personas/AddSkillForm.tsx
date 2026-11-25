import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { MAX_SKILL_NAME, MAX_SKILLS } from '@roundtable/contract';
import { Button, TextField } from '../../design-system';
import { api } from '../../shared/api';
import styles from './SkillsPage.module.css';
import { skillsQueryKey } from './queries';

/**
 * Why a Skill name can't be sent, in plain words: one of only spaces trims to nothing, which the
 * contract's `SkillName` refuses with a generic message. The field's `maxLength` covers the length.
 */
export function skillNameProblem(value: string) {
  return value.trim() === '' ? 'Enter a skill name.' : undefined;
}

/**
 * Adds a Skill. The field clears once it's added; a name the API refuses (taken, say) stays, with
 * the reason under it. A full library (`MAX_SKILLS`, archived ones included) disables the form.
 */
export function AddSkillForm({ full }: { readonly full: boolean }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string>();

  const create = useMutation({
    mutationFn: api.createSkill,
    onSuccess: async () => {
      // The list is asked again first, so the new Skill shows as the field clears.
      await queryClient.invalidateQueries({ queryKey: skillsQueryKey });
      setName('');
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const why = skillNameProblem(name);

    setProblem(why);

    // The client sends the name trimmed (the contract's SkillName), so it's trimmed here first.
    if (!why) create.mutate({ name: name.trim() });
  }

  return (
    <form className={styles.add} aria-label="Add a skill" onSubmit={onSubmit}>
      <TextField
        label="Skill name"
        description={
          full
            ? `Your library is full: it holds at most ${MAX_SKILLS} skills, archived ones included.`
            : undefined
        }
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setProblem(undefined);
          create.reset();
        }}
        maxLength={MAX_SKILL_NAME}
        required
        disabled={full}
        error={problem ?? create.error?.message}
      />
      <Button type="submit" disabled={full || create.isPending}>
        Add skill
      </Button>
    </form>
  );
}
