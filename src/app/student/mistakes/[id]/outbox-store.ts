import {
  EMPTY,
  outboxKey,
  parse,
  serialise,
  type Outbox,
} from "@/core/attempts/outbox";

/**
 * The outbox as an EXTERNAL STORE, not as component state.
 *
 * localStorage is a browser store, and this codebase's rule is that a browser
 * store is read through `useSyncExternalStore` — `ThemeToggle` does it for the
 * theme and the exam player does it for `navigator.onLine`. Reading it in a
 * mount effect and calling `setState` is a cascading render, which
 * `react-hooks/set-state-in-effect` rejects as an error rather than a warning.
 *
 * Beside the practice one rather than shared with it: each surface reads its
 * own scope, and a single module taking a scope argument would be one cache
 * keyed by two things — which is how a set and a retry end up overwriting each
 * other's unsent answer.
 *
 * So the snapshot lives here, is read from storage on first access, and is
 * replaced only by `write()`. The cached object matters as much as the
 * persistence: `useSyncExternalStore` compares snapshots by identity, and a
 * fresh `parse()` on every render would be a new object every time and would
 * loop forever.
 */

const listeners = new Set<() => void>();

/** One entry per mistake id, so two tabs never share a snapshot. */
const cache = new Map<string, Outbox>();

function load(mistakeId: string): Outbox {
  try {
    return parse(localStorage.getItem(outboxKey("mistake", mistakeId)));
  } catch {
    // Private window, or storage blocked. An unreadable queue must not take
    // the page down with it: the worst case is the answer is sent again,
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

export function read(mistakeId: string): Outbox {
  const cached = cache.get(mistakeId);
  if (cached) return cached;
  const loaded = load(mistakeId);
  cache.set(mistakeId, loaded);
  return loaded;
}

/** The server-render snapshot: there is no storage there, and no queue. */
export function empty(): Outbox {
  return EMPTY;
}

export function write(mistakeId: string, outbox: Outbox): void {
  cache.set(mistakeId, outbox);
  try {
    localStorage.setItem(outboxKey("mistake", mistakeId), serialise(outbox));
  } catch {
    // The in-memory snapshot still sends; only surviving a reload is lost, and
    // that is not worth an error message on top of a question.
  }
  for (const listener of listeners) listener();
}
