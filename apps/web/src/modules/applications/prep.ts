import { useQueryClient } from '@tanstack/react-query';
import { MAX_PREP_TASK_TITLE, type Skill } from '@roundtable/contract';
import { agendaQueryKey, roundsQueryKey } from './queries';

// What a Round's Prep (GLOSSARY.md) and each of its prep tasks share: the Skill picker's options,
// the title rule, and what to refresh after a change.

/** The Skill picker's value for a task that names no Skill: never a Skill's id, which is a UUID. */
export const NO_SKILL = 'none';

/** A Skill's name as a prep task shows it, marked when it's archived. */
export const skillLabel = (skill: Skill) =>
  skill.archivedAt === null ? skill.name : `${skill.name} (archived)`;

/**
 * The Skill picker's options: "No skill", then the active Skills in the order `useSkills()` gives
 * them (by name). `keep` is the Skill a task already names, which stays selectable if archived.
 */
export const skillOptions = (skills: readonly Skill[], keep: string | null = null) => [
  { value: NO_SKILL, label: 'No skill' },
  ...skills.flatMap((skill) =>
    skill.archivedAt === null || skill.id === keep
      ? [{ value: skill.id, label: skillLabel(skill) }]
      : [],
  ),
];

/** What the API is sent for a picked option: a Skill's id, or null for "No skill". */
export const skillIdOf = (choice: string) => (choice === NO_SKILL ? null : choice);

/** Why a task's title can't be sent, in plain words: blank or too long. */
export function titleProblem(value: string) {
  const length = value.trim().length;

  if (length === 0) return 'Enter a task.';

  return length > MAX_PREP_TASK_TITLE
    ? `A task can be at most ${MAX_PREP_TASK_TITLE} characters.`
    : undefined;
}

/**
 * Refreshes what a change to a Round's Prep shows in: the application's Rounds, and the Agenda,
 * which carries each Round's prep tasks.
 */
export function useRefreshPrep(applicationId: string) {
  const queryClient = useQueryClient();

  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: roundsQueryKey(applicationId) }),
      queryClient.invalidateQueries({ queryKey: agendaQueryKey }),
    ]);
}
