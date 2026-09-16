"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * "I have seen this."
 *
 * Deliberately the only thing a teacher can do to a gap from here. There is no
 * dismiss and no close — a gap resolves when the class is measured again and
 * comes back above the line, and a button that could short-circuit that would
 * turn the list into a measure of housekeeping.
 */
export function AcknowledgeButton({ gapId }: { gapId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function acknowledge() {
    setPending(true);
    try {
      await fetch(`/api/gaps/${gapId}/acknowledge/`, { method: "POST" });
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      className="ui-button"
      data-variant="secondary"
      data-size="sm"
      disabled={pending}
      onClick={() => void acknowledge()}
    >
      <span>{pending ? "Saving…" : "Mark as seen"}</span>
    </button>
  );
}
