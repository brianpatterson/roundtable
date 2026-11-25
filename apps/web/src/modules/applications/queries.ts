// The applications module's server state. Its query keys start with 'applications', so no other
// module's cache entries collide with them, and invalidating the list also refreshes every
// application's own page.
export const applicationsQueryKey = ['applications'] as const;

/** One application, for its page. */
export const applicationQueryKey = (id: string) => [...applicationsQueryKey, id] as const;

/**
 * The Agenda (ADR-0070): Rounds across applications, so under the list's key, which anything that
 * changes an application or adds a Round invalidates. Editing or deleting a Round invalidates it
 * itself.
 */
export const agendaQueryKey = [...applicationsQueryKey, 'agenda'] as const;

/** One application's Rounds: invalidating the application refreshes them too. */
export const roundsQueryKey = (id: string) => [...applicationQueryKey(id), 'rounds'] as const;
