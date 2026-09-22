import type { Metadata } from "next";
import { TryAgain } from "./TryAgain";

export const metadata: Metadata = { title: "No connection" };

// Static on purpose: the service worker caches this one page, and a page that
// read a session could not be cached without caching somebody's data with it.
export const dynamic = "force-static";

/**
 * What the installed app shows when a page cannot load. It states only what is
 * true on every device: answers already given were written to this device
 * first, and nothing here was lost.
 */
export default function OfflinePage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <div style={{ maxWidth: "46ch", textAlign: "center" }}>
        <h1 className="ui-page-title">No connection</h1>
        <p className="ui-page-description" style={{ margin: "10px auto 14px" }}>
          This page needs the internet, and this device cannot reach it right now.
        </p>
        <p className="ui-page-description" style={{ margin: "0 auto 22px" }}>
          Answers you already gave — in a test, in practice or in Things to fix —
          are saved on this device. They go up by themselves when you open the same
          page again with a connection. Nothing is lost.
        </p>
        <TryAgain />
      </div>
    </main>
  );
}
