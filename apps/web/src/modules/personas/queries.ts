import { useQuery } from '@tanstack/react-query';
import { api } from '../../shared/api';

// The personas module's server state. Its query keys start with 'personas', so no other module's
// cache entries collide with them.
export const personasQueryKey = ['personas'] as const;

/** Every Skill of the user's, archived ones included, in the API's order (by name). */
export const skillsQueryKey = [...personasQueryKey, 'skills'] as const;

/**
 * The skill library: every Skill of the user's, archived ones included, by name ignoring case.
 * The one place the browser asks for it, so a Skill added, renamed or archived on the Skills page
 * shows the same everywhere that names it (prep tasks pick from it).
 */
export function useSkills() {
  return useQuery({ queryKey: skillsQueryKey, queryFn: api.listSkills });
}
