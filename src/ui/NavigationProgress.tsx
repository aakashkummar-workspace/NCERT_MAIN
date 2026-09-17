"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";

/**
 * Feedback from the instant a link is pressed until the next page arrives.
 *
 * ---------------------------------------------------------------------------
 * Why not a loading.tsx skeleton
 * ---------------------------------------------------------------------------
 * A route-level skeleton replaces the WHOLE page, navigation included, because
 * each page renders its own shell. Every click therefore blanked the screen
 * into grey boxes and then drew the page — which read as the product being
 * slower, not faster. Without one, the App Router keeps the current page up
 * until the next is ready, and the only thing missing is proof that the click
 * registered. This supplies exactly that: a bar along the top, and the pressed
 * menu item taking the "current" look straight away.
 *
 * It listens on the document, in the capture phase, so it sees a click before
 * `<Link>` handles it and covers every surface's navigation without any shell
 * having to know it exists. It never prevents or changes navigation.
 */

type Pending = { from: string; link: HTMLAnchorElement; startedAt: number };

/** A navigation that never lands (a handler that cancelled it) must not spin forever. */
const GIVE_UP_MS = 20_000;

let pending: Pending | null = null;
const listeners = new Set<() => void>();

function setPending(next: Pending | null) {
  pending?.link.removeAttribute("data-pending");
  pending = next;
  next?.link.setAttribute("data-pending", "true");
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) document.addEventListener("click", onClick, true);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) document.removeEventListener("click", onClick, true);
  };
}

function onClick(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const target = event.target instanceof Element ? event.target : null;
  const link = target?.closest<HTMLAnchorElement>("a[href]");
  if (!link || link.hasAttribute("download")) return;
  if (link.target && link.target !== "_self") return;

  const url = new URL(link.href, window.location.href);
  if (url.origin !== window.location.origin) return;
  // A file download (a marks export) is a GET to an API route: no page follows.
  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname === window.location.pathname && url.search === window.location.search) return;

  setPending({
    from: window.location.pathname + window.location.search,
    link,
    startedAt: Date.now(),
  });
}

export function NavigationProgress() {
  const current = useSyncExternalStore(
    subscribe,
    () => pending,
    () => null,
  );
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const here = pathname + (search ? `?${search}` : "");

  const landed = current !== null && current.from !== here;

  useEffect(() => {
    if (landed) setPending(null);
  }, [landed]);

  useEffect(() => {
    if (!current) return;
    const timer = window.setTimeout(
      () => setPending(null),
      Math.max(0, GIVE_UP_MS - (Date.now() - current.startedAt)),
    );
    return () => window.clearTimeout(timer);
  }, [current]);

  if (!current || landed) return null;
  return (
    <div className="ui-nav-progress" role="progressbar" aria-label="Opening page">
      <span className="ui-nav-progress-bar" />
    </div>
  );
}
