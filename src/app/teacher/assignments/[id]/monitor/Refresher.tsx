"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Re-reads the live view on a timer.
 *
 * `router.refresh()` rather than a fetch into client state: the page is a
 * server component, so one mechanism produces the figures and one mechanism
 * updates them. A second client-side reader would eventually disagree with the
 * server about who is still writing.
 *
 * Fifteen seconds. An exam clock moves in minutes, and a poll per second would
 * put thirty sittings through the database every second of a paper for a screen
 * nobody reads that fast.
 *
 * It stops when the tab is hidden: an invigilator's laptop left open on the
 * staffroom desk should not hold a connection open all afternoon.
 */
const EVERY_MS = 15_000;

export function Refresher({ live }: { live: boolean }) {
  const router = useRouter();
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!live) return;
    const onVisibility = () => setPaused(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [live]);

  useEffect(() => {
    if (!live || paused) return;
    const timer = setInterval(() => router.refresh(), EVERY_MS);
    return () => clearInterval(timer);
  }, [live, paused, router]);

  if (!live) return null;

  return (
    <p className="ui-live-refresh" role="status">
      {paused
        ? "Paused while this tab is in the background."
        : `Updating every ${EVERY_MS / 1000} seconds.`}{" "}
      <button type="button" className="ui-link-button" onClick={() => router.refresh()}>
        Refresh now
      </button>
    </p>
  );
}
