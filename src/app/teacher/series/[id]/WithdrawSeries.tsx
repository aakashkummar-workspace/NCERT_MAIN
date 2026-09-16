"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/ui";

/**
 * Withdrawing a series.
 *
 * The confirm names the number of papers and says they are left alone, because
 * this control sits next to six exams and the fear it has to answer is that
 * pressing it cancels them. It does not: the label goes, the papers run.
 */
export function WithdrawSeries({
  seriesId,
  name,
  papers,
}: {
  seriesId: string;
  name: string;
  papers: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function withdraw() {
    const held =
      papers === 0
        ? "It holds no papers."
        : papers === 1
          ? "Its one paper is left exactly as it is — same window, same students, same marks. It is not cancelled."
          : `Its ${papers} papers are left exactly as they are — same windows, same students, same marks. They are not cancelled.`;
    if (!window.confirm(`Withdraw “${name}”?\n\n${held}`)) return;

    setBusy(true);
    try {
      const response = await fetch(`/api/series/${seriesId}/`, { method: "DELETE" });
      if (!response.ok) {
        setBusy(false);
        return;
      }
      router.push("/teacher/series");
      router.refresh();
    } catch {
      setBusy(false);
    }
  }

  return (
    <Button
      variant="secondary"
      size="md"
      onClick={() => void withdraw()}
      loading={busy}
      loadingLabel="Withdrawing"
    >
      Withdraw series
    </Button>
  );
}
