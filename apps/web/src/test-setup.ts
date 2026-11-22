import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library only cleans up on its own when the test runner exposes a global afterEach.
afterEach(cleanup);

// The router scrolls to the top on every navigation; jsdom has no layout, so nothing to scroll.
window.scrollTo = () => {};
