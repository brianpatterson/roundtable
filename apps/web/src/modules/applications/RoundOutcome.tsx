import { useMutation, useQueryClient } from '@tanstack/react-query';
import { isInferredOutcome, type Outcome, type Round } from '@roundtable/contract';
import { Alert, Select } from '../../design-system';
import { api } from '../../shared/api';
import { roundsQueryKey } from './queries';
import styles from './Rounds.module.css';

// A Round's Outcome (GLOSSARY.md): whether the user advanced past it. Picking one saves it at
// once, and the API records that the user set it, so an inferred one never replaces it. One the
// API inferred is marked as such (ADR-0060).

const outcomeOptions = [
  { value: 'pending', label: 'Pending' },
  { value: 'passed', label: 'Passed' },
  { value: 'failed', label: 'Failed' },
  { value: 'unknown', label: 'Unknown (never told)' },
] as const satisfies readonly { value: Outcome; label: string }[];

/**
 * The menu's options for `round`: an inferred Outcome reads `Passed (inferred)`, so the user can
 * tell it from one they set. Picking another sets theirs.
 */
const optionsFor = (round: Round) =>
  isInferredOutcome(round)
    ? outcomeOptions.map((option) =>
        option.value === round.outcome
          ? { ...option, label: `${option.label} (inferred)` }
          : option,
      )
    : outcomeOptions;

/** The Round's Outcome, as a menu that sets it. */
export function RoundOutcome({ round, name }: { round: Round; name: string }) {
  const queryClient = useQueryClient();

  // Pending until the Rounds are fetched again, so the menu never flips back to the old Outcome.
  const save = useMutation({
    mutationFn: (outcome: Outcome) =>
      api.setRoundOutcome(round.applicationId, round.id, { outcome }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: roundsQueryKey(round.applicationId) }),
  });

  return (
    <div role="group" aria-label={`${name} outcome`} className={styles.outcome}>
      <Select
        label="Outcome"
        options={save.isPending ? outcomeOptions : optionsFor(round)}
        value={save.isPending ? save.variables : round.outcome}
        disabled={save.isPending}
        onValueChange={(outcome) => save.mutate(outcome)}
      />
      {save.error && <Alert tone="error">{save.error.message}</Alert>}
    </div>
  );
}
