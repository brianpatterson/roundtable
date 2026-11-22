import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';

/**
 * For tests: a router that shows `ui` at every path, starting at `path`, so a module's `Link`s
 * render and can be followed without the shell's routes (modules can't import the router or the
 * shell, ADR-0049). Where a link went is in `router.state.location`.
 */
export function createTestRouter(ui: ReactNode, path = '/') {
  const rootRoute = createRootRoute({ component: () => ui });
  const everyPath = createRoute({ getParentRoute: () => rootRoute, path: '$' });

  return createRouter({
    routeTree: rootRoute.addChildren([everyPath]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
}

export type TestRouter = ReturnType<typeof createTestRouter>;

export function TestRouterProvider({ router }: { router: TestRouter }) {
  return <RouterProvider router={router} />;
}
