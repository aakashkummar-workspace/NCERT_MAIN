import {
  EMPTY,
  outboxKey,
  parse,
  serialise,
  type Outbox,
} from "@/core/practice/outbox";

/**
 * The outbox as an EXTERNAL STORE, not as component state.
 *
 * localStorage is a browser store, and this codebase's rule is that a browser
 * store is read through `useSyncExternalStore` — `ThemeToggle` does it for the
 * theme and the exam player does it for `navigator.onLine`. Reading it in a
 * mount effect and calling `setState` is a cascading render, which
 * `react-hooks/set-state-in-effect` rejects as an error rather than a warning.
 *
 * So the snapshot lives here, is read from storage on first access, and is
 * replaced only by `write()`. The cached object matters as much as the
 * persistence: `useSyncExternalStore` compares snapshots by identity, and a
 * fresh `parse()` on every render would be a new object every time and would
 * loop forever.
 */

const listeners = new Set<() => void>();

/** One entry per session id. Two sets open in two tabs never share a snapshot. */
const cache = new Map<string, Outbox>();

function load(sessionId: string): Outbox {
  try {
    return parse(localStorage.getItem(outboxKey(sessionId)));
  } catch {
    // Private window, or storage blocked. An unreadable queue must not take
    // the runner down with it: the worst case is the answer is sent again,
    // which the server now replays rather than refusing.
    return EMPTY;
  }
}

export function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function read(sessionId: string): Outbox {
  const cached = cache.get(sessionId);
  if (cached) return cached;
  const loaded = load(sessionId);
  cache.set(sessionId, loaded);
  return loaded;
}

/** The server-render snapshot: there is no storage there, and no queue. */
export function empty(): Outbox {
  return EMPTY;
}

export function write(sessionId: string, outbox: Outbox): void {
  cache.set(sessionId, outbox);
  try {
    localStorage.setItem(outboxKey(sessionId), serialise(outbox));
  } catch {
    // The in-memory snapshot still sends; only surviving a reload is lost, and
    // that is not worth an error message on top of a question.
  }
  for (const listener of listeners) listener();
}
