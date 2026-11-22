import { createLink, type LinkComponent } from '@tanstack/react-router';
import type { AnchorHTMLAttributes } from 'react';
import styles from './Link.module.css';

/** The anchor the router renders: the design system's look, the router's `href` and click. */
function Anchor(props: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'className' | 'style'>) {
  return <a {...props} className={styles.link} />;
}

const RouterLink = createLink(Anchor);

/**
 * A link to another page of the app (ADR-0049). Its `to` and `params` are checked against the
 * shell's routes at compile time, and following it changes the page without reloading. For a
 * page outside the app, use a plain `<a>`.
 */
export const Link: LinkComponent<typeof Anchor> = (props) => <RouterLink {...props} />;
