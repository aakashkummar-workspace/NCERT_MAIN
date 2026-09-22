"use client";

import { useEffect } from "react";

/**
 * Registers /sw.js in a production build only. Under `next dev` a service
 * worker serving cached chunks is a stale page that looks like a bug in
 * whatever was just edited.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {
      // An app that cannot install still works as a website; nothing to say.
    });
  }, []);
  return null;
}
