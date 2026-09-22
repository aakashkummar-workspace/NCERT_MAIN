"use client";

import { Button } from "@/ui";

/** Reload whatever address the student was trying to reach, not /offline/. */
export function TryAgain() {
  return (
    <Button variant="primary" onClick={() => window.location.reload()}>
      Try again
    </Button>
  );
}
