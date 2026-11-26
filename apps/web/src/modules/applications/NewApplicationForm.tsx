import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ApplicationStatus } from '@roundtable/contract';
import { Alert, Button, Select, TextField } from '../../design-system';
import { api } from '../../shared/api';
import { usePersonas } from '../personas';
import styles from './NewApplicationForm.module.css';
import { NO_PERSONA, personaIdOf, personaOptions } from './persona';
import { applicationsQueryKey } from './queries';

export function NewApplicationForm() {
  const queryClient = useQueryClient();
  const personas = usePersonas();
  const [company, setCompany] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [jobUrl, setJobUrl] = useState('');
  const [personaChoice, setPersonaChoice] = useState(NO_PERSONA);
  // Only an active Persona can be picked, so without one there's nothing to choose.
  const canPickPersona = personas.data?.some((persona) => persona.archivedAt === null) ?? false;
  // Which button submitted the form. Enter in a field clicks the first one, Add, so it's set either
  // way; a ref, because the submit event follows the click before React re-renders.
  const status = useRef<ApplicationStatus>('applied');

  const create = useMutation({
    mutationFn: api.createApplication,
    onSuccess: () => {
      setCompany('');
      setJobTitle('');
      setJobUrl('');
      setPersonaChoice(NO_PERSONA);

      return queryClient.invalidateQueries({ queryKey: applicationsQueryKey });
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    create.mutate({
      company,
      jobTitle,
      jobUrl: jobUrl || null,
      status: status.current,
      // Without the field, None: a choice left from before the last active Persona went.
      personaId: canPickPersona ? personaIdOf(personaChoice) : null,
    });
  }

  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <TextField
        label="Company"
        value={company}
        onChange={(e) => setCompany(e.target.value)}
        required
      />
      <TextField
        label="Job title"
        value={jobTitle}
        onChange={(e) => setJobTitle(e.target.value)}
        required
      />
      <TextField
        label="Job description link"
        description="Optional"
        type="url"
        value={jobUrl}
        onChange={(e) => setJobUrl(e.target.value)}
      />
      {canPickPersona && (
        <Select
          label="Persona"
          options={personaOptions(personas.data ?? [])}
          value={personaChoice}
          onValueChange={setPersonaChoice}
        />
      )}
      <div className={styles.submit}>
        <Button
          type="submit"
          disabled={create.isPending}
          onClick={() => (status.current = 'applied')}
        >
          Add as applied
        </Button>
        <Button
          type="submit"
          variant="outlined"
          disabled={create.isPending}
          onClick={() => (status.current = 'saved')}
        >
          Save for later
        </Button>
      </div>
      {create.isError && <Alert tone="error">{create.error.message}</Alert>}
    </form>
  );
}
