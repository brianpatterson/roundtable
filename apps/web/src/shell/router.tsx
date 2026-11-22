import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { useState } from 'react';
import { ApplicationPage, ApplicationsPage } from '../modules/applications';
import { NotFoundPage } from './NotFoundPage';

// The web app's routes (ADR-0049). The shell owns them: each path maps to a module's root
// component, with the URL's params passed as props, so no module knows the router or another
// module. Data loads through TanStack Query, not the router's loaders.

const rootRoute = createRootRoute({ component: Outlet, notFoundComponent: NotFoundPage });

const applicationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: ApplicationsPage,
});

const applicationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/applications/$applicationId',
  component: function ApplicationRoute() {
    const { applicationId } = applicationRoute.useParams();

    return <ApplicationPage applicationId={applicationId} />;
  },
});

const routeTree = rootRoute.addChildren([applicationsRoute, applicationRoute]);

const createAppRouter = () => createRouter({ routeTree });

// Checks every `Link`'s `to` and `params` against these routes at compile time.
declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}

/**
 * The signed-in pages, at the browser's URL. The shell renders it inside `AuthGate`, so a link
 * opened while signed out shows sign-in first and then this page, still at the same URL: the
 * router is made when it mounts, after sign-in.
 */
export function Routes() {
  const [router] = useState(createAppRouter);

  return <RouterProvider router={router} />;
}
