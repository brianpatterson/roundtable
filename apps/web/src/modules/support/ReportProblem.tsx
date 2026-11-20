import { useId, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { REPORT_DESCRIPTION_MAX } from '@roundtable/contract';
import { Alert, Button, Dialog, TextArea, TextField } from '../../design-system';
import { api } from '../../shared/api';
import styles from './ReportProblem.module.css';

export interface ReportProblemProps {
  /** Pre-fills the reply email: the signed-in user's own address. The user can change it. */
  readonly defaultReplyEmail?: string;
}

/**
 * "Report a problem" (ADR-0037): a link-style button that opens a short form. Works signed out
 * (the sign-in page) and signed in; the API links a signed-in report to the account itself,
 * from the session cookie. Sends the page path without its query string, which can hold tokens.
 */
export function ReportProblem({ defaultReplyEmail }: ReportProblemProps) {
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [replyEmail, setReplyEmail] = useState('');

  const send = useMutation({ mutationFn: api.createReport });

  function openForm() {
    setDescription('');
    setReplyEmail(defaultReplyEmail ?? '');
    send.reset();
    setOpen(true);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    send.mutate({
      description,
      // An email input already strips surrounding whitespace; empty means no reply wanted.
      replyEmail: replyEmail || null,
      pagePath: window.location.pathname,
    });
  }

  const sent = send.isSuccess;

  return (
    <>
      <Button variant="text" onClick={openForm}>
        Report a problem
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Report a problem"
        description={
          sent
            ? 'Thanks: your report reached us.'
            : 'Tell us what went wrong, in a few words. What you write is kept private: only the people who run Roundtable read it.'
        }
        actions={
          sent ? (
            <Button onClick={() => setOpen(false)}>Close</Button>
          ) : (
            <>
              <Button variant="text" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" form={formId} disabled={send.isPending}>
                Send report
              </Button>
            </>
          )
        }
      >
        {sent ? (
          <Alert>Report {send.data.id}. Quote it if you write to us about this.</Alert>
        ) : (
          <form id={formId} className={styles.form} onSubmit={onSubmit}>
            <TextArea
              label="What went wrong?"
              description={`Up to ${REPORT_DESCRIPTION_MAX.toLocaleString('en')} characters`}
              maxLength={REPORT_DESCRIPTION_MAX}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
            />
            <TextField
              label="Reply email"
              description="Optional: only if you'd like an answer"
              type="email"
              autoComplete="email"
              value={replyEmail}
              onChange={(e) => setReplyEmail(e.target.value)}
            />
            {send.isError && <Alert tone="error">{send.error.message}</Alert>}
          </form>
        )}
      </Dialog>
    </>
  );
}
