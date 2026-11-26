import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { AgendaPage, ApplicationPage, ApplicationsPage } from '../modules/applications';
import { PersonaPage, PersonasPage, SkillsPage } from '../modules/personas';
import { NotFoundPage } from './NotFoundPage';

// The web app's routes (ADR-0049). The shell owns them: each path maps to a module's root
// component, with the URL's params passed as props, so no module knows the router or another
// module. Data loads through TanStack Query, not the router's loaders.

/** What every page shows above it (the header), given by `Routes`'s caller. */
const LayoutContext = createContext<ReactNode>(null);

/** Every page: the layout around it, inside the router, so its links know the current page. */
function Layout() {
  return (
    <>
      {useContext(LayoutContext)}
      <Outlet />
    </>
  );
}

const rootRoute = createRootRoute({ component: Layout, notFoundComponent: NotFoundPage });

// The Agenda is the home page; the Applications table has its own (ADR-0070).
const agendaRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: AgendaPage,
});

const applicationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/applications',
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

const skillsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/skills',
  component: SkillsPage,
});

const personasRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/personas',
  component: PersonasPage,
});

const personaRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/personas/$personaId',
  component: function PersonaRoute() {
    const { personaId } = personaRoute.useParams();

    return <PersonaPage personaId={personaId} />;
  },
});

const routeTree = rootRoute.addChildren([
  agendaRoute,
  applicationsRoute,
  applicationRoute,
  personasRoute,
  personaRoute,
  skillsRoute,
]);

const createAppRouter = () => createRouter({ routeTree });

// Checks every `Link`'s `to` and `params` against these routes at compile time.
declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}

/**
 * The signed-in pages, at the browser's URL, each below `header`. The shell renders it inside
 * `AuthGate`, so a link opened while signed out shows sign-in first and then this page, still at
 * the same URL: the router is made when it mounts, after sign-in.
 */
export function Routes({ header }: { header?: ReactNode }) {
  const [router] = useState(createAppRouter);

  return (
    <LayoutContext value={header}>
      <RouterProvider router={router} />
    </LayoutContext>
  );
}
