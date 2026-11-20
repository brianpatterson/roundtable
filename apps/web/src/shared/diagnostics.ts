// What the browser saw before a problem report (ADR-0041): the latest API requests and uncaught
// errors, kept in memory only and sent with a report, so the factory can reproduce the bug without
// asking the user. Never request or response bodies, never query strings (a reset link's token is
// in one), and every string cut to the contract's limits before it's sent.
import {
  DIAGNOSTIC_ERRORS_MAX,
  DIAGNOSTIC_MESSAGE_MAX,
  DIAGNOSTIC_REQUESTS_MAX,
  DIAGNOSTIC_STACK_MAX,
  REPORT_PAGE_PATH_MAX,
  type ReportDiagnostics,
} from '@roundtable/contract';

interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly at: number;
}

interface SeenError {
  readonly message: string;
  readonly stack?: string;
  readonly at: number;
}

const requests: SeenRequest[] = [];
const errors: SeenError[] = [];

function keepLatest<T>(list: T[], item: T, max: number) {
  list.push(item);

  if (list.length > max) list.splice(0, list.length - max);
}

/** The path of a same-origin `/api/` request, without its query or hash; undefined otherwise. */
function apiPath(url: string): string | undefined {
  const parsed = new URL(url, window.location.origin);

  if (parsed.origin !== window.location.origin || !parsed.pathname.startsWith('/api/')) {
    return undefined;
  }

  return parsed.pathname.slice(0, REPORT_PAGE_PATH_MAX);
}

/** The report itself isn't something the user saw go wrong. */
const REPORT_PATH = '/api/reports';

/**
 * Notes one API request: its method, path and status (0 when the network failed). Anything that
 * isn't a same-origin `/api/` request, and the report itself, is ignored.
 */
export function recordRequest(method: string, url: string | URL, status: number) {
  const path = apiPath(String(url));

  if (!path || path === REPORT_PATH) return;

  keepLatest(
    requests,
    { method: method.toUpperCase().slice(0, 10), path, status, at: Date.now() },
    DIAGNOSTIC_REQUESTS_MAX,
  );
}

/**
 * A fetch that notes each API request (`recordRequest`), then answers exactly as `inner` does.
 * The typed client uses it; Better Auth's client notes its requests through its own hook.
 */
export function recordingFetch(
  inner: typeof fetch = (input, init) => globalThis.fetch(input, init),
): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');

    try {
      const response = await inner(input, init);

      recordRequest(method, url, response.status);

      return response;
    } catch (error) {
      recordRequest(method, url, 0);
      throw error;
    }
  };
}

/** An error as the report keeps it. */
export interface CapturedError {
  readonly message: string;
  readonly stack?: string | undefined;
}

/** Notes an uncaught error or an unhandled rejection, cut to the contract's limits. */
export function recordError({ message, stack }: CapturedError) {
  keepLatest(
    errors,
    {
      message: message.slice(0, DIAGNOSTIC_MESSAGE_MAX),
      ...(stack && { stack: stack.slice(0, DIAGNOSTIC_STACK_MAX) }),
      at: Date.now(),
    },
    DIAGNOSTIC_ERRORS_MAX,
  );
}

/** An Error as the report keeps it: its name with its message, and its stack. */
const fromError = (error: Error): CapturedError => ({
  message: `${error.name}: ${error.message}`,
  stack: error.stack,
});

/**
 * Starts noting uncaught errors and unhandled rejections. Call once, at startup. Anything thrown
 * that isn't an Error is described by the event's message, or as text.
 */
export function recordUncaughtErrors() {
  window.addEventListener('error', (event) =>
    recordError(
      event.error instanceof Error
        ? fromError(event.error)
        : { message: event.message || 'Unknown error' },
    ),
  );
  window.addEventListener('unhandledrejection', (event) =>
    recordError(
      event.reason instanceof Error
        ? fromError(event.reason)
        : { message: `Unhandled rejection: ${String(event.reason)}` },
    ),
  );
}

const secondsBefore = (now: number, at: number) =>
  Math.min(86_400, Math.max(0, Math.round((now - at) / 1000)));

const dimension = (value: number) => Math.min(100_000, Math.max(0, Math.round(value)));

/** Everything noted so far, as a report sends it. */
export function collectDiagnostics(now = Date.now()): ReportDiagnostics {
  const theme = document.documentElement.dataset['theme'];

  return {
    viewport: { width: dimension(window.innerWidth), height: dimension(window.innerHeight) },
    theme: theme === 'light' || theme === 'dark' ? theme : 'system',
    requests: requests.map(({ at, ...request }) => ({
      ...request,
      secondsBefore: secondsBefore(now, at),
    })),
    errors: errors.map(({ at, ...error }) => ({ ...error, secondsBefore: secondsBefore(now, at) })),
  };
}

/** Tests: forgets everything noted. */
export function clearDiagnostics() {
  requests.length = 0;
  errors.length = 0;
}
