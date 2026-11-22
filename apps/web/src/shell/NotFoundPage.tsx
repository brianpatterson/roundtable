import { Link } from '../design-system';

/** What a path with no page shows. */
export function NotFoundPage() {
  return (
    <section>
      <h2>Page not found</h2>
      <p>There’s no page at this address.</p>
      <p>
        <Link to="/">Back to my applications</Link>
      </p>
    </section>
  );
}
