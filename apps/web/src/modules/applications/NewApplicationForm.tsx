import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, TextField } from '../../design-system';
import { api } from '../../shared/api';
import styles from './NewApplicationForm.module.css';
import { applicationsQueryKey } from './queries';

export function NewApplicationForm() {
  const queryClient = useQueryClient();
  const [company, setCompany] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [jobUrl, setJobUrl] = useState('');

  const create = useMutation({
    mutationFn: api.createApplication,
    onSuccess: () => {
      setCompany('');
      setJobTitle('');
      setJobUrl('');

      return queryClient.invalidateQueries({ queryKey: applicationsQueryKey });
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    create.mutate({ company, jobTitle, jobUrl: jobUrl || null });
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
      <div className={styles.submit}>
        <Button type="submit" disabled={create.isPending}>
          Add
        </Button>
      </div>
      {create.isError && <Alert tone="error">{create.error.message}</Alert>}
    </form>
  );
}
