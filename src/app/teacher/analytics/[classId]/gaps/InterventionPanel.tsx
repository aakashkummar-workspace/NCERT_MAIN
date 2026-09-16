"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/ui";

/**
 * The gap-to-improvement loop, on the card.
 *
 * Three states, and the panel is only ever in one of them:
 *
 *   nothing yet   — offer to build a paper, or to record what you did anyway
 *   in progress   — show the stamp, offer to measure
 *   measured      — show what happened, including when it did not work
 *
 * The baseline is printed in every state after the first. It is the number the
 * improvement is measured against, and a claim whose baseline is not on screen
 * is a claim nobody can check.
 */

export type PanelIntervention = {
  id: string;
  kind: string;
  status: string;
  baselineMastery: number;
  baselineStudentCount: number;
  targetMastery: number;
  outcomeMastery: number | null;
  delta: number | null;
  metTarget: boolean | null;
  outcomeStudentCount: number | null;
  /** The students the baseline described, read as of the measurement. */
  cohort: {
    students: number;
    measured: number;
    mean: number | null;
    source: "remedial-targets" | "ledger";
  } | null;
  note: string | null;
  assignmentId: string | null;
};

type Plan = {
  conceptName: string;
  studentUserIds: string[];
  chosen: { questionId: string }[];
  totalMarks: number;
  durationMinutes: number;
  mix: { EASY: number; MEDIUM: number; HARD: number };
  chosenByDifficulty: { EASY: number; MEDIUM: number; HARD: number };
  notes: string[];
  feasible: boolean;
  problems: string[];
};

/** "3 easy, 5 medium and nothing hard" — what is on the paper, counted. */
function describeMix(counts: Plan["chosenByDifficulty"]): string {
  const parts = (["EASY", "MEDIUM", "HARD"] as const)
    .filter((level) => counts[level] > 0)
    .map((level) => `${counts[level]} ${level.toLowerCase()}`);
  const list =
    parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return counts.HARD === 0 ? `${list}, nothing hard` : list;
}

const KIND_LABEL: Record<string, string> = {
  REMEDIAL_ASSESSMENT: "Remedial paper",
  PRACTICE_SET: "Practice set",
  LESSON_PLAN: "Reteaching",
  MANUAL: "Something else",
};

const percent = (value: number) => `${Math.round(value * 100)}%`;

/**
 * The gap threshold. Restated rather than imported: this is a client component
 * and `core/gaps/rules` sits beside server-only modules. Used only to word a
 * sentence, never to decide anything.
 */
const LINE = 0.6;

/** A week from now, at 4pm, to the minute — the shape a datetime-local wants. */
function defaultWindow() {
  const opens = new Date();
  opens.setHours(opens.getHours() + 24, 0, 0, 0);
  const closes = new Date(opens);
  closes.setDate(closes.getDate() + 7);
  const local = (date: Date) =>
    new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);
  return { opensAt: local(opens), closesAt: local(closes) };
}

export function InterventionPanel({
  gapId,
  intervention,
  gapClosed = false,
}: {
  gapId: string;
  intervention: PanelIntervention | null;
  /** The evidence has closed the gap. Nothing new can start; what ran can be measured. */
  gapClosed?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [note, setNote] = useState("");
  const [showNote, setShowNote] = useState(false);
  const [window_, setWindow] = useState(defaultWindow);

  async function send(path: string, method: string, body?: unknown) {
    setPending(path);
    setError(null);
    try {
      const response = await fetch(path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        setError(json?.error?.message ?? "Something went wrong. Try again.");
        return null;
      }
      return json;
    } finally {
      setPending(null);
    }
  }

  async function preview() {
    const result = await send(`/api/gaps/${gapId}/remedial/`, "GET");
    if (result) setPlan(result as Plan);
  }

  async function build() {
    const result = await send(`/api/gaps/${gapId}/remedial/`, "POST", {
      opensAt: new Date(window_.opensAt).toISOString(),
      closesAt: new Date(window_.closesAt).toISOString(),
    });
    if (result) {
      setPlan(null);
      router.refresh();
    }
  }

  async function record(kind: string) {
    const result = await send(`/api/gaps/${gapId}/intervene/`, "POST", {
      kind,
      note: note.trim() || undefined,
    });
    if (result) {
      setShowNote(false);
      setNote("");
      router.refresh();
    }
  }

  async function measure() {
    if (!intervention) return;
    const result = await send(
      `/api/interventions/${intervention.id}/measure/`,
      "POST",
    );
    if (result) router.refresh();
  }

  // ---------------------------------------------------------------- measured
  if (intervention?.status === "MEASURED" && intervention.outcomeMastery !== null) {
    const worked = intervention.metTarget === true;
    const moved = (intervention.delta ?? 0) > 0.02;

    return (
      <div className="ui-intervention" data-outcome={worked ? "met" : "missed"}>
        <div className="ui-intervention-head">
          <span className="ui-intervention-kind">
            {KIND_LABEL[intervention.kind] ?? intervention.kind}
          </span>
          <Badge tone={worked ? "success" : "warning"}>
            {worked ? "Target met" : "Target missed"}
          </Badge>
        </div>

        {/*
          Both numbers, always. "Improved by 12 points" without the baseline is
          a marketing claim; with it, it is a measurement a teacher can argue
          with.
        */}
        <p className="ui-intervention-line">
          <span className="tabular">{percent(intervention.baselineMastery)}</span>{" "}
          <span aria-hidden="true">→</span>{" "}
          <span className="tabular">{percent(intervention.outcomeMastery)}</span>{" "}
          <span className="ui-intervention-delta" data-direction={moved ? "up" : "flat"}>
            {(intervention.delta ?? 0) >= 0 ? "+" : "−"}
            {Math.abs(Math.round((intervention.delta ?? 0) * 100))} points
          </span>{" "}
          against a target of{" "}
          <span className="tabular">{percent(intervention.targetMastery)}</span>.
        </p>

        {intervention.outcomeStudentCount !== null && (
          <p className="ui-intervention-note">
            {/*
              Which population each number is over, in words. The outcome is
              read over whoever is still below the line when it is measured,
              and without saying so a lesson that lifted most of the room reads
              as having made things worse.
            */}
            The first figure is the {intervention.baselineStudentCount}{" "}
            {intervention.baselineStudentCount === 1 ? "student" : "students"} below
            the line when this started.{" "}
            {/*
              A mean over students below the line is below the line, so an
              outcome at or above it can only be the everyone-measured case.
            */}
            {intervention.outcomeMastery >= LINE
              ? `Nobody was below it when it was measured, so the second is all ${intervention.outcomeStudentCount} measured ${intervention.outcomeStudentCount === 1 ? "student" : "students"}.`
              : `The second is the ${intervention.outcomeStudentCount} ${intervention.outcomeStudentCount === 1 ? "student" : "students"} still below it when it was measured — not the same group, so read the line below as well.`}
          </p>
        )}

        {intervention.cohort && intervention.cohort.students > 0 && (
          <p className="ui-intervention-note">
            <strong>The same students, followed:</strong>{" "}
            {intervention.cohort.mean === null
              ? `none of the ${intervention.cohort.students} who were behind when it started has enough evidence to read.`
              : `the ${intervention.cohort.students} who were behind when it started ${
                  intervention.cohort.source === "remedial-targets"
                    ? "(the students the paper was set to)"
                    : "(worked out again from the evidence recorded by that day)"
                } averaged ${percent(intervention.cohort.mean)} when it was measured${
                  intervention.cohort.measured < intervention.cohort.students
                    ? `, across the ${intervention.cohort.measured} with enough evidence`
                    : ""
                }.`}
          </p>
        )}

        {!worked && (
          // Said plainly. A measured failure is the most useful row in this
          // table, and softening it into "some progress" is how a product
          // stops being worth the subscription.
          <p className="ui-intervention-verdict">
            {gapClosed
              ? "It did not reach its target, although the class is no longer below the line overall. The students still behind are the ones to look at."
              : moved
                ? "It moved them, but not far enough to call the concept secure. The gap stays open until the evidence closes it."
                : "It did not move them. Whatever comes next should be different in kind, not more of the same."}
          </p>
        )}

        {intervention.note && (
          <p className="ui-intervention-note">{intervention.note}</p>
        )}
      </div>
    );
  }

  // ------------------------------------------------------------- in progress
  if (intervention) {
    return (
      <div className="ui-intervention">
        <div className="ui-intervention-head">
          <span className="ui-intervention-kind">
            {KIND_LABEL[intervention.kind] ?? intervention.kind}
          </span>
          <Badge tone="primary">{gapClosed ? "Ready to measure" : "In progress"}</Badge>
        </div>

        {gapClosed && (
          <p className="ui-intervention-verdict">
            The gap closed while this was open. Measure it to record whether it
            reached its target — a success nobody measured cannot be told apart
            from luck.
          </p>
        )}

        <p className="ui-intervention-line">
          Baseline stamped at{" "}
          <span className="tabular">{percent(intervention.baselineMastery)}</span>{" "}
          across {intervention.baselineStudentCount}{" "}
          {intervention.baselineStudentCount === 1 ? "student" : "students"}.
          Counts as landed at{" "}
          <span className="tabular">{percent(intervention.targetMastery)}</span>.
        </p>

        {intervention.note && (
          <p className="ui-intervention-note">{intervention.note}</p>
        )}

        {intervention.assignmentId && (
          <p className="ui-intervention-note">
            <Link href={`/teacher/assignments/${intervention.assignmentId}`}>
              See who has sat it
            </Link>
          </p>
        )}

        {error && <p className="ui-intervention-error">{error}</p>}

        <div className="ui-intervention-actions">
          <button
            type="button"
            className="ui-button"
            data-variant="secondary"
            data-size="sm"
            disabled={pending !== null}
            onClick={() => void measure()}
          >
            <span>{pending ? "Reading…" : "Measure it now"}</span>
          </button>
          <span className="ui-intervention-hint">
            {/*
              Told before they press it, because it cannot be undone and a
              teacher who measures on the day of the lesson gets a number that
              says the lesson failed.
            */}
            Reads the current mastery and records it once. Do this after the
            work has been marked.
          </span>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------- nothing yet
  return (
    <div className="ui-intervention" data-empty="true">
      {error && <p className="ui-intervention-error">{error}</p>}

      {plan && (
        <div className="ui-intervention-plan">
          {plan.feasible ? (
            <>
              <p className="ui-intervention-line">
                <strong>{plan.chosen.length} questions</strong> on{" "}
                {plan.conceptName}, {plan.totalMarks} marks in{" "}
                {plan.durationMinutes} minutes, to the{" "}
                <strong>{plan.studentUserIds.length}</strong>{" "}
                {plan.studentUserIds.length === 1 ? "student" : "students"} below
                the line — nobody else in the class sees it.
              </p>
              <p className="ui-intervention-note">
                {/*
                  The mix, in words. A teacher who disagrees with the
                  calibration should be able to see it and say so, rather than
                  discover it when the papers come back.
                */}
                {/*
                  Counted from the questions actually chosen, not the
                  calibration's percentages. It used to print "70% easy" above
                  a paper the bank could only fill with medium questions.
                */}
                On the paper: {describeMix(plan.chosenByDifficulty)}
                {plan.notes.length === 0 &&
                  plan.mix.HARD === 0 &&
                  " — they are a long way behind, and a hard question here would only measure that again"}
                .
              </p>
              {plan.notes.map((note) => (
                <p key={note} className="ui-intervention-verdict">
                  {note}
                </p>
              ))}

              <div className="ui-intervention-window">
                <label>
                  <span>Opens</span>
                  <input
                    type="datetime-local"
                    className="ui-input"
                    value={window_.opensAt}
                    onChange={(event) =>
                      setWindow((current) => ({
                        ...current,
                        opensAt: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  <span>Closes</span>
                  <input
                    type="datetime-local"
                    className="ui-input"
                    value={window_.closesAt}
                    onChange={(event) =>
                      setWindow((current) => ({
                        ...current,
                        closesAt: event.target.value,
                      }))
                    }
                  />
                </label>
              </div>

              <div className="ui-intervention-actions">
                <button
                  type="button"
                  className="ui-button"
                  data-variant="primary"
                  data-size="sm"
                  disabled={pending !== null}
                  onClick={() => void build()}
                >
                  <span>{pending ? "Building…" : "Build and assign it"}</span>
                </button>
                <button
                  type="button"
                  className="ui-button"
                  data-variant="ghost"
                  data-size="sm"
                  disabled={pending !== null}
                  onClick={() => setPlan(null)}
                >
                  <span>Cancel</span>
                </button>
              </div>
            </>
          ) : (
            <>
              {plan.problems.map((problem) => (
                <p key={problem} className="ui-intervention-verdict">
                  {problem}
                </p>
              ))}
              <div className="ui-intervention-actions">
                <button
                  type="button"
                  className="ui-button"
                  data-variant="ghost"
                  data-size="sm"
                  onClick={() => setPlan(null)}
                >
                  <span>Close</span>
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {showNote && (
        <div className="ui-intervention-plan">
          <label className="ui-intervention-note-field">
            <span>What are you doing about it?</span>
            <textarea
              className="ui-textarea"
              rows={2}
              maxLength={1000}
              value={note}
              placeholder="Reteaching with the ladder diagram on Monday, then a worksheet."
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <p className="ui-intervention-note">
            {/*
              The reason this exists at all. Most teaching happens off the
              platform, and a product that could only measure what it generated
              itself would be measuring itself.
            */}
            The mastery today is stamped as the baseline. Come back after the
            next paper is marked and measure it.
          </p>
          <div className="ui-intervention-actions">
            <button
              type="button"
              className="ui-button"
              data-variant="primary"
              data-size="sm"
              disabled={pending !== null}
              onClick={() => void record("LESSON_PLAN")}
            >
              <span>{pending ? "Saving…" : "Start and stamp the baseline"}</span>
            </button>
            <button
              type="button"
              className="ui-button"
              data-variant="ghost"
              data-size="sm"
              disabled={pending !== null}
              onClick={() => setShowNote(false)}
            >
              <span>Cancel</span>
            </button>
          </div>
        </div>
      )}

      {!plan && !showNote && (
        <div className="ui-intervention-actions">
          <button
            type="button"
            className="ui-button"
            data-variant="primary"
            data-size="sm"
            disabled={pending !== null}
            onClick={() => void preview()}
          >
            <span>{pending ? "Checking the bank…" : "Build a remedial paper"}</span>
          </button>
          <button
            type="button"
            className="ui-button"
            data-variant="secondary"
            data-size="sm"
            disabled={pending !== null}
            onClick={() => setShowNote(true)}
          >
            <span>Record what you are doing</span>
          </button>
        </div>
      )}
    </div>
  );
}
