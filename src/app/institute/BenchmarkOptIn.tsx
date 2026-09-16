"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card } from "@/ui";

/**
 * Agreeing to contribute this school's figures to the cross-school benchmarks.
 *
 * The card is written to be read before it is pressed, so it says exactly what
 * leaves: a mean and a count per idea, never a student, never a class, never a
 * name. And it says what comes back whether or not they agree, because
 * contributing is not the price of reading, and a switch that quietly bought
 * something would make it one.
 */
export function BenchmarkOptIn({
  contributing,
  concepts,
  minSchools,
  minStudents,
}: {
  contributing: boolean;
  /** How many ideas this school currently contributes a figure on. */
  concepts: number;
  minSchools: number;
  minStudents: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<number | null>(null);

  async function set(next: boolean) {
    if (busy) return;
    if (!next) {
      const held =
        concepts === 0
          ? "Nothing of this school's has been published into a benchmark yet."
          : concepts === 1
            ? "The one figure this school contributes is deleted, not just frozen."
            : `All ${concepts} figures this school contributes are deleted, not just frozen.`;
      if (!window.confirm(`Stop contributing to the benchmarks?\n\n${held}`)) return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/institute/benchmarks/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contributing: next }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error?.message ?? "That did not save. Try again.");
        return;
      }
      setRemoved(next ? null : (payload?.removed ?? 0));
      router.refresh();
    } catch {
      setError("We could not reach the server. Nothing changed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Cross-school benchmarks"
      description="How an idea is going here, against the middle school among everyone measuring it."
    >
      <p className="ui-benchmark-copy">
        A benchmark answers one question a school cannot answer alone: is this
        idea hard everywhere, or is it hard here? Below {minSchools} schools
        measuring the same idea there is no figure at all — with fewer, a median
        describes the schools in it rather than the idea.
      </p>

      <p className="ui-benchmark-copy">
        <strong>What leaves this school if you agree:</strong> one average and
        one student count per idea, computed here, and only where at least{" "}
        {minStudents} students have enough evidence to be measured. No student,
        no class, no teacher and no paper — and nothing that names this school.
        What comes back is a median and a spread, never a ranking and never a
        list of who else is in it.
      </p>

      <p className="ui-benchmark-copy">
        <strong>You can read the benchmarks either way.</strong> Contributing is
        not the price of reading them. Withdrawing deletes what this school has
        published rather than freezing it.
      </p>

      {error && (
        <p className="ui-error" role="alert">
          {error}
        </p>
      )}
      {removed !== null && (
        <p className="ui-hint" role="status">
          {removed === 0
            ? "Stopped. There was nothing published to remove."
            : `Stopped, and ${removed} ${removed === 1 ? "figure" : "figures"} were deleted.`}
        </p>
      )}

      <div className="ui-benchmark-foot">
        <span className="ui-benchmark-state" data-on={contributing || undefined}>
          {contributing
            ? concepts === 0
              ? "Contributing — nothing published yet, the nightly job has not run or nothing is measured enough"
              : `Contributing on ${concepts} ${concepts === 1 ? "idea" : "ideas"}`
            : "Not contributing"}
        </span>
        <Button
          variant={contributing ? "secondary" : "primary"}
          size="sm"
          onClick={() => void set(!contributing)}
          loading={busy}
          loadingLabel="Saving"
        >
          {contributing ? "Stop contributing" : "Contribute this school's figures"}
        </Button>
      </div>
    </Card>
  );
}
