import { useQueryClient } from '@tanstack/react-query';
import { MAX_PREP_TASK_TITLE, type Persona, type Skill } from '@roundtable/contract';
import type { SelectGroup, SelectOption } from '../../design-system';
import { agendaQueryKey, roundsQueryKey } from './queries';

// What a Round's Prep (GLOSSARY.md) and each of its prep tasks share: the Skill picker's options,
// the title rule, and what to refresh after a change.

/** The Skill picker's value for a task that names no Skill: never a Skill's id, which is a UUID. */
export const NO_SKILL = 'none';

/** A Skill's name as a prep task shows it, marked when it's archived. */
export const skillLabel = (skill: Skill) =>
  skill.archivedAt === null ? skill.name : `${skill.name} (archived)`;

const optionOf = (skill: Skill): SelectOption<string> => ({
  value: skill.id,
  label: skillLabel(skill),
});

/**
 * The Skill picker's options, for the add and the edit form alike: "No skill", then the active
 * Skills. `keep` is the Skill a task already names, which stays selectable if archived.
 *
 * When the Application's Persona has active Skills (archived or not, the Application still uses
 * it), they come first in a group named after it, in the Persona's order, and the rest follow in
 * "Other skills" by name (the order `useSkills()` gives them). Otherwise the Skills are one flat
 * list by name. Each Skill is listed once; the Select hides an empty "Other skills".
 */
export function skillGroups(
  skills: readonly Skill[],
  persona: Persona | undefined,
  keep: string | null = null,
): readonly SelectGroup<string>[] {
  const none = { options: [{ value: NO_SKILL, label: 'No skill' }] };
  const listed = skills.filter((skill) => skill.archivedAt === null || skill.id === keep);
  const ownIds = new Set(persona?.skillIds);

  const own = (persona?.skillIds ?? []).flatMap((id) => listed.filter((skill) => skill.id === id));

  if (!persona || !own.some((skill) => skill.archivedAt === null)) {
    return [none, { options: listed.map(optionOf) }];
  }

  return [
    none,
    { label: persona.name, options: own.map(optionOf) },
    {
      label: 'Other skills',
      options: listed.flatMap((skill) => (ownIds.has(skill.id) ? [] : [optionOf(skill)])),
    },
  ];
}

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
