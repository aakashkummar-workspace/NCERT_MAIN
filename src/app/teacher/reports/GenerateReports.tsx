"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Writing a term's reports for a class.
 *
 * The class, not the student, is the unit — a teacher does not write one report
 * before parents' evening, they write thirty. Per-student refusals come back
 * named: a teacher who gets 26 of 30 needs to know which four and why, before
 * one of those four's parents asks.
 */

type Row = {
  studentUserId: string;
  fullName: string;
  reportId: string | null;
  skipped: string | null;
};

export function GenerateReports({
  classes,
  defaultStart,
  defaultEnd,
  blocked = null,
}: {
  classes: { id: string; name: string; subjectName: string }[];
  defaultStart: string;
  defaultEnd: string;
  /** Why the plan will refuse, known before the form is shown. */
  blocked?: string | null;
}) {
  const router = useRouter();
  const [classId, setClassId] = useState(classes[0]?.id ?? "");
  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState(defaultEnd);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);

  const badPeriod = start !== "" && end !== "" && end <= start;

  async function run() {
    setPending(true);
    setError(null);
    setRows(null);
    try {
      const result = await fetch("/api/reports/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          classId,
          periodStart: new Date(`${start}T00:00:00`).toISOString(),
          periodEnd: new Date(`${end}T23:59:59`).toISOString(),
        }),
      });
      const json = await result.json().catch(() => null);
      if (!result.ok) {
        setError(json?.error?.message ?? "We could not write those reports.");
        return;
      }
      setRows(json.rows as Row[]);
      router.refresh();
    } catch {
      setError("We could not reach the server. Check your connection.");
    } finally {
      setPending(false);
    }
  }

  if (blocked) {
    return (
      <section className="ui-report-generate" aria-live="polite">
        <p className="ui-hint" style={{ margin: 0 }}>
          {blocked} Reports that were already written stay readable below.{" "}
          <Link href="/teacher/settings">See what your plan includes</Link>.
        </p>
      </section>
    );
  }

  if (classes.length === 0) {
    return (
      <p className="ui-hint">
        Reports are written for a class. Create a class and add some students
        first.
      </p>
    );
  }

  const written = rows?.filter((row) => row.reportId !== null) ?? [];
  const skipped = rows?.filter((row) => row.reportId === null) ?? [];

  return (
    <section className="ui-report-generate">
      <div className="ui-report-generate-fields">
        <label className="ui-field">
          <span>Class</span>
          <select
            className="ui-input"
            value={classId}
            onChange={(event) => setClassId(event.target.value)}
          >
            {classes.map((klass) => (
              <option key={klass.id} value={klass.id}>
                {klass.name} · {klass.subjectName}
              </option>
            ))}
          </select>
        </label>

        <label className="ui-field">
          <span>From</span>
          <input
            type="date"
            className="ui-input"
            value={start}
            onChange={(event) => setStart(event.target.value)}
          />
        </label>

        <label className="ui-field">
          <span>To</span>
          <input
            type="date"
            className="ui-input"
            value={end}
            onChange={(event) => setEnd(event.target.value)}
          />
        </label>
      </div>

      {/*
        Refused while typing rather than on submit — the same rule the
        assignment window follows, so a teacher never presses the button and
        meets a refusal they could have been shown.
      */}
      {badPeriod && (
        <p className="ui-report-generate-error">
          The period ends before it starts.
        </p>
      )}
      {error && <p className="ui-report-generate-error">{error}</p>}

      <div className="ui-report-actions">
        <button
          type="button"
          className="ui-button"
          data-variant="primary"
          data-size="md"
          disabled={pending || badPeriod || classId === ""}
          onClick={() => void run()}
        >
          <span>{pending ? "Writing…" : "Write reports for this class"}</span>
        </button>
      </div>

      {rows !== null && (
        <div className="ui-report-run">
          <p className="ui-report-run-head">
            {written.length === 0
              ? "No reports were written."
              : `${written.length} ${written.length === 1 ? "report" : "reports"} written.`}
          </p>
          {skipped.length > 0 && (
            <>
              {/*
                Named, never swallowed. A silent skip is a parent who does not
                get a report and a teacher who finds out from them.
              */}
              <p className="ui-report-run-head">
                {skipped.length === 1
                  ? "One was not written:"
                  : `${skipped.length} were not written:`}
              </p>
              <ul className="ui-report-run-skipped">
                {skipped.map((row) => (
                  <li key={row.studentUserId}>
                    <strong>{row.fullName}</strong>
                    <span>{row.skipped}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}
