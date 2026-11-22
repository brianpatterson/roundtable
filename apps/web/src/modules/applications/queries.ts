// The applications module's server state. Its query keys start with 'applications', so no other
// module's cache entries collide with them, and invalidating the list also refreshes every
// application's own page.
export const applicationsQueryKey = ['applications'] as const;

/** One application, for its page. */
export const applicationQueryKey = (id: string) => [...applicationsQueryKey, id] as const;
