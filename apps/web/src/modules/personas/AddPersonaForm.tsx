import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { MAX_PERSONA_NAME, MAX_PERSONAS } from '@roundtable/contract';
import { Button, TextField } from '../../design-system';
import { api } from '../../shared/api';
import styles from './Personas.module.css';
import { personaListQueryKey } from './queries';

/**
 * Why a Persona name can't be sent, in plain words: one of only spaces trims to nothing, which the
 * contract's `PersonaName` refuses with a generic message. The field's `maxLength` covers the length.
 */
export function personaNameProblem(value: string) {
  return value.trim() === '' ? 'Enter a persona name.' : undefined;
}

/**
 * Adds a Persona. The field clears once it's added; a name the API refuses (taken, say) stays,
 * with the reason under it. `MAX_PERSONAS` Personas, archived ones included, disable the form.
 */
export function AddPersonaForm({ full }: { readonly full: boolean }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string>();

  const create = useMutation({
    mutationFn: api.createPersona,
    onSuccess: async () => {
      // The list is asked again first, so the new Persona shows as the field clears.
      await queryClient.invalidateQueries({ queryKey: personaListQueryKey });
      setName('');
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const why = personaNameProblem(name);

    setProblem(why);

    // The client sends the name trimmed (the contract's PersonaName), so it's trimmed here first.
    if (!why) create.mutate({ name: name.trim() });
  }

  return (
    <form className={styles.add} aria-label="Add a persona" onSubmit={onSubmit}>
      <TextField
        label="Persona name"
        description={
          full
            ? `You've reached the limit: at most ${MAX_PERSONAS} personas, archived ones included.`
            : undefined
        }
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setProblem(undefined);
          create.reset();
        }}
        maxLength={MAX_PERSONA_NAME}
        required
        disabled={full}
        error={problem ?? create.error?.message}
      />
      <Button type="submit" disabled={full || create.isPending}>
        Add persona
      </Button>
    </form>
  );
}
