import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Link } from './Link';

// Two pages that link to each other, in a router of their own: the app's routes are the shell's.
const renderPages = () => {
  const rootRoute = createRootRoute({ component: Outlet });

  const home = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <Link to="/applications/$applicationId" params={{ applicationId: 'a1' }}>
        Acme
      </Link>
    ),
  });

  const application = createRoute({
    getParentRoute: () => rootRoute,
    path: '/applications/$applicationId',
    component: () => <Link to="/">Back to my applications</Link>,
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([home, application]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });

  render(<RouterProvider router={router} />);

  return router;
};

describe('Link', () => {
  it('is a link to the page its route and params name', async () => {
    renderPages();

    const link = await screen.findByRole('link', { name: 'Acme' });

    expect(link.getAttribute('href')).toBe('/applications/a1');
  });

  it('goes to that page when followed, and back again', async () => {
    const router = renderPages();

    await userEvent.click(await screen.findByRole('link', { name: 'Acme' }));
    expect(router.state.location.pathname).toBe('/applications/a1');

    await userEvent.click(await screen.findByRole('link', { name: 'Back to my applications' }));
    expect(router.state.location.pathname).toBe('/');
    expect(await screen.findByRole('link', { name: 'Acme' })).toBeDefined();
  });
});
