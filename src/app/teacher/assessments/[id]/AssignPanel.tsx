"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  describeWindow,
  suggestWindow,
  validateWindow,
} from "@/core/assignments/window";
import { Alert, Badge, Button, Card, Field, Input, Select, type Tone } from "@/ui";

type ClassOption = { id: string; name: string; studentCount: number };

type Existing = {
  id: string;
  className: string;
  opensAt: string;
  closesAt: string;
  status: string;
  targetedCount: number | null;
  classSize: number;
};

const STATUS_TONE: Record<string, Tone> = {
  SCHEDULED: "primary",
  OPEN: "success",
  CLOSED: "neutral",
  CANCELLED: "neutral",
};

/**
 * Turns a Date into the value a `datetime-local` input wants — which is local
 * wall-clock with no zone. The reverse trip is `new Date(value)`, which the
 * browser reads back as local time, so the instant survives intact.
 */
function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function AssignPanel({
  assessmentId,
  durationMinutes,
  classes,
  existing,
}: {
  assessmentId: string;
  durationMinutes: number;
  classes: ClassOption[];
  existing: Existing[];
}) {
  const router = useRouter();
  const suggested = suggestWindow(durationMinutes);

  const [open, setOpen] = useState(existing.length === 0);
  const [classId, setClassId] = useState(classes[0]?.id ?? "");
  const [opensAt, setOpensAt] = useState(toLocalInput(suggested.opensAt));
  const [closesAt, setClosesAt] = useState(toLocalInput(suggested.closesAt));
  const [maxAttempts, setMaxAttempts] = useState(1);
  const [resultsPolicy, setResultsPolicy] = useState<
    "IMMEDIATE" | "AFTER_CLOSE" | "MANUAL"
  >("AFTER_CLOSE");
  const [onPaper, setOnPaper] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The same function the server runs, so a teacher never presses Assign and
  // meets a refusal they could have been shown.
  const problems = validateWindow({
    opensAt: new Date(opensAt),
    closesAt: new Date(closesAt),
    durationMinutes,
    maxAttempts,
  });

  const klass = classes.find((c) => c.id === classId);

  async function assign() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/assignments/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assessmentId,
          classId,
          opensAt: new Date(opensAt).toISOString(),
          closesAt: new Date(closesAt).toISOString(),
          maxAttempts,
          resultsPolicy,
          deliveryMode: onPaper ? "PAPER" : "ONLINE",
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error?.message ?? "That could not be assigned.");
        setBusy(false);
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setError("We could not reach the server. Nothing was assigned.");
    }
    setBusy(false);
  }

  return (
    <>
      {existing.length > 0 && (
        <Card title={`Assigned ${existing.length === 1 ? "once" : `${existing.length} times`}`}>
          <ul className="ui-assignment-list">
            {existing.map((item) => (
              <li key={item.id}>
                <Link href={`/teacher/assignments/${item.id}`}>
                  <span className="ui-assignment-class">{item.className}</span>
                  <span className="ui-assignment-when">
                    <Badge tone={STATUS_TONE[item.status] ?? "neutral"}>
                      {item.status.charAt(0) + item.status.slice(1).toLowerCase()}
                    </Badge>
                    <span>
                      {describeWindow({
                        opensAt: new Date(item.opensAt),
                        closesAt: new Date(item.closesAt),
                      })}
                    </span>
                    <span className="tabular">
                      {item.targetedCount ?? item.classSize}{" "}
                      {(item.targetedCount ?? item.classSize) === 1
                        ? "student"
                        : "students"}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {!open && (
            <div style={{ marginTop: 14 }}>
              <Button variant="secondary" onClick={() => setOpen(true)}>
                Assign to another class
              </Button>
            </div>
          )}
        </Card>
      )}

      {open && (
        <Card
          title="Assign this paper"
          description="Publishing froze the questions. Assigning decides who sits it, and when."
        >
          {error && <Alert tone="danger">{error}</Alert>}

          {classes.length === 0 ? (
            <Alert tone="warning" title="No class studies this subject yet">
              Create a class for this subject first, and add the students who
              will sit the paper.
            </Alert>
          ) : (
            <>
              <Field label="Class" htmlFor="ap-class">
                <Select
                  id="ap-class"
                  value={classId}
                  onChange={(event) => setClassId(event.target.value)}
                >
                  {classes.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name} ({option.studentCount}{" "}
                      {option.studentCount === 1 ? "student" : "students"})
                    </option>
                  ))}
                </Select>
              </Field>

              {klass?.studentCount === 0 && (
                <Alert tone="warning">
                  That class has no students yet, so nobody would receive this.
                </Alert>
              )}

              <div className="ui-editor-row" style={{ marginTop: 14 }}>
                <Field label="Opens" htmlFor="ap-opens">
                  <Input
                    id="ap-opens"
                    type="datetime-local"
                    value={opensAt}
                    onChange={(event) => setOpensAt(event.target.value)}
                  />
                </Field>
                <Field label="Closes" htmlFor="ap-closes">
                  <Input
                    id="ap-closes"
                    type="datetime-local"
                    value={closesAt}
                    onChange={(event) => setClosesAt(event.target.value)}
                  />
                </Field>
              </div>

              <div className="ui-editor-row" style={{ marginTop: 4 }}>
                <Field
                  label="Attempts allowed"
                  htmlFor="ap-attempts"
                  hint="One is usual for an assessment."
                >
                  <Input
                    id="ap-attempts"
                    type="number"
                    min={1}
                    max={5}
                    value={maxAttempts}
                    onChange={(event) =>
                      setMaxAttempts(Number(event.target.value))
                    }
                    aria-describedby="ap-attempts-hint"
                  />
                </Field>
                <Field
                  label="When students see results"
                  htmlFor="ap-results"
                  hint={
                    resultsPolicy === "IMMEDIATE"
                      ? "The first to finish can tell the rest what came up."
                      : undefined
                  }
                >
                  <Select
                    id="ap-results"
                    value={resultsPolicy}
                    onChange={(event) =>
                      setResultsPolicy(
                        event.target.value as typeof resultsPolicy,
                      )
                    }
                    aria-describedby="ap-results-hint"
                  >
                    <option value="AFTER_CLOSE">After the window closes</option>
                    <option value="MANUAL">When I release them</option>
                    <option value="IMMEDIATE">Straight away</option>
                  </Select>
                </Field>
              </div>

              <label className="ui-outcome-choice" style={{ marginTop: 14 }}>
                <input
                  type="checkbox"
                  checked={onPaper}
                  onChange={(event) => setOnPaper(event.target.checked)}
                />
                <span>
                  <strong>Sat on paper in class.</strong> Students will not start it on a
                  device. Afterwards you type in or scan each student&rsquo;s answer sheet,
                  and it counts exactly like an online sitting.
                </span>
              </label>

              {problems.length > 0 && (
                <ul className="ui-check-list" style={{ marginTop: 14 }}>
                  {problems.map((problem, index) => (
                    <li key={index}>
                      <Badge tone="danger">Must fix</Badge>
                      <span>{problem.message}</span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="ui-row" style={{ marginTop: 16 }}>
                <Button
                  variant="primary"
                  onClick={assign}
                  disabled={problems.length > 0 || !classId}
                  loading={busy}
                  loadingLabel="Assigning…"
                >
                  Assign
                </Button>
                {existing.length > 0 && (
                  <Button variant="ghost" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                )}
              </div>
            </>
          )}
        </Card>
      )}
    </>
  );
}
