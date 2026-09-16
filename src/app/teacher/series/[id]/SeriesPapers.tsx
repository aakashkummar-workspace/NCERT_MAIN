"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Field, Select, TrashIcon } from "@/ui";

/**
 * Putting papers in a series, and taking them out.
 *
 * Every window state is offered, finished ones included: a school routinely
 * sets six papers in a week and names the event afterwards, and a picker that
 * hid the shut ones would make grouping a half-yearly impossible the day after
 * it ended.
 *
 * Taking a paper out does nothing to the paper. It keeps its window, its
 * students and its marks; only the grouping goes. The confirm says so, because
 * "remove" beside an exam reads like cancelling one.
 */

export type Available = {
  assignmentId: string;
  title: string;
  className: string;
  status: string;
};

export function SeriesPapers({
  seriesId,
  available,
  inSeries,
}: {
  seriesId: string;
  available: Available[];
  inSeries: { assignmentId: string; title: string; className: string }[];
}) {
  const router = useRouter();
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!choice || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/series/${seriesId}/papers/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignmentId: choice }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.error?.message ?? "That did not save. Try again.");
        return;
      }
      setChoice("");
      router.refresh();
    } catch {
      setError("We could not reach the server. Nothing changed.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(paper: { assignmentId: string; title: string }) {
    if (
      !window.confirm(
        `Take ${paper.title} out of this series?\n\nThe paper itself is untouched — same window, same students, same marks. It just stops being grouped here.`,
      )
    ) {
      return;
    }
    setRemoving(paper.assignmentId);
    setError(null);
    try {
      const response = await fetch(`/api/series/${seriesId}/papers/`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignmentId: paper.assignmentId }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.error?.message ?? "That did not change. Try again.");
        return;
      }
      router.refresh();
    } catch {
      setError("We could not reach the server. Nothing changed.");
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div className="ui-series-papers">
      {error && <Alert tone="danger">{error}</Alert>}

      {available.length === 0 ? (
        <p className="ui-hint">
          Every paper you have assigned is already in a series. Assign another
          one from a class, and it can be added here.
        </p>
      ) : (
        <div className="ui-series-add">
          <Field label="Add a paper" htmlFor="series-add">
            <Select
              id="series-add"
              value={choice}
              onChange={(event) => setChoice(event.target.value)}
            >
              <option value="">Choose a paper…</option>
              {available.map((paper) => (
                <option key={paper.assignmentId} value={paper.assignmentId}>
                  {paper.title} — {paper.className}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void add()}
            disabled={!choice}
            loading={busy}
            loadingLabel="Adding"
          >
            Add
          </Button>
        </div>
      )}

      {inSeries.length > 0 && (
        <ul className="ui-series-remove-list">
          {inSeries.map((paper) => (
            <li key={paper.assignmentId}>
              <span>
                {paper.title}
                <span className="ui-series-remove-class"> · {paper.className}</span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void remove(paper)}
                loading={removing === paper.assignmentId}
                loadingLabel="Removing"
                aria-label={`Take ${paper.title} out of this series`}
              >
                <TrashIcon size={14} />
                <span>Take out</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
