"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { checkBasics } from "@/core/assessments/basics";
import { Alert, Button, Field, Input, Select } from "@/ui";

type Grade = {
  id: string;
  number: number;
  label: string;
  subjects: { id: string; name: string }[];
};

type ClassOption = {
  id: string;
  name: string;
  gradeNumber: number;
  subjectName: string;
};

/**
 * Starting an assessment.
 *
 * Deliberately four fields, not a page: the interesting decisions live in the
 * builder, and asking for them twice would make the first screen feel like
 * paperwork.
 */
export function NewAssessment({
  grades,
  classes,
  academicYear,
  label = "Build an assessment",
  initialClassId,
}: {
  grades: Grade[];
  classes: ClassOption[];
  academicYear: string;
  label?: string;
  /**
   * Arrived from a class page's "Create Assessment": open the form with that
   * class, its grade and its subject already chosen. It came from a URL, so it
   * only counts when it names one of this school's classes AND a grade and
   * subject the form can offer — otherwise the form opens closed, as before.
   */
  initialClassId?: string;
}) {
  const router = useRouter();
  const preset = presetFor(grades, classes, initialClassId);
  const [open, setOpen] = useState(preset !== null);
  const [gradeId, setGradeId] = useState(preset?.gradeId ?? grades[0]?.id ?? "");
  const [subjectId, setSubjectId] = useState(
    preset?.subjectId ?? grades[0]?.subjects[0]?.id ?? "",
  );
  const [classId, setClassId] = useState(preset?.classId ?? "");
  const [title, setTitle] = useState(`Class test — ${academicYear}`);
  const [duration, setDuration] = useState(45);
  const [totalMarks, setTotalMarks] = useState(20);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [serverFields, setServerFields] = useState<Record<string, string>>({});
  // Checked live with the same bounds the server enforces, so a 0-minute paper
  // is told so beside the box instead of meeting "Check the highlighted fields"
  // with nothing highlighted.
  const fieldErrors = {
    ...serverFields,
    ...checkBasics({ title, durationMinutes: duration, totalMarks }),
  } as Record<string, string | undefined>;
  const hasFieldErrors = Object.values(
    checkBasics({ title, durationMinutes: duration, totalMarks }),
  ).some(Boolean);

  const grade = grades.find((g) => g.id === gradeId);

  function onGradeChange(next: string) {
    setGradeId(next);
    setSubjectId(grades.find((g) => g.id === next)?.subjects[0]?.id ?? "");
    setClassId("");
  }

  // Only classes that actually study this subject, so the mismatch the server
  // refuses cannot be chosen in the first place.
  const eligibleClasses = classes.filter(
    (klass) =>
      klass.gradeNumber === grade?.number &&
      klass.subjectName === grade?.subjects.find((s) => s.id === subjectId)?.name,
  );

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/assessments/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          subjectId,
          gradeId,
          classId: classId || null,
          durationMinutes: duration,
          totalMarks,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const fields = payload?.error?.details?.fields as Record<string, string> | undefined;
        setServerFields(fields ?? {});
        setError(
          fields && Object.keys(fields).length > 0
            ? "Fix the fields marked below. Nothing was created."
            : (payload?.error?.message ?? "That did not save."),
        );
        setBusy(false);
        return;
      }
      router.push(`/teacher/assessments/${payload.id}`);
      router.refresh();
    } catch {
      setError("We could not reach the server. Nothing was created.");
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button variant="primary" onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }

  return (
    <div className="ui-new-assessment">
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="ui-editor-row">
        <Field label="Class year" htmlFor="na-grade">
          <Select
            id="na-grade"
            value={gradeId}
            onChange={(event) => onGradeChange(event.target.value)}
          >
            {grades.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Subject" htmlFor="na-subject">
          <Select
            id="na-subject"
            value={subjectId}
            onChange={(event) => {
              setSubjectId(event.target.value);
              setClassId("");
            }}
          >
            {(grade?.subjects ?? []).map((subject) => (
              <option key={subject.id} value={subject.id}>
                {subject.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field label="Name" htmlFor="na-title" error={fieldErrors.title}>
        <Input
          id="na-title"
          value={title}
          invalid={Boolean(fieldErrors.title)}
          aria-describedby={fieldErrors.title ? "na-title-error" : undefined}
          onChange={(event) => {
            setTitle(event.target.value);
            setServerFields({});
          }}
          maxLength={120}
        />
      </Field>

      <div className="ui-editor-row" style={{ marginTop: 12 }}>
        <Field
          label="For a class"
          htmlFor="na-class"
          hint={
            eligibleClasses.length === 0
              ? "No class studies this subject yet. You can still build the paper."
              : undefined
          }
        >
          <Select
            id="na-class"
            value={classId}
            onChange={(event) => setClassId(event.target.value)}
            disabled={eligibleClasses.length === 0}
          >
            <option value="">Any class</option>
            {eligibleClasses.map((klass) => (
              <option key={klass.id} value={klass.id}>
                {klass.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Minutes" htmlFor="na-duration" error={fieldErrors.durationMinutes}>
          <Input
            id="na-duration"
            type="number"
            min={5}
            max={360}
            value={Number.isNaN(duration) ? "" : duration}
            invalid={Boolean(fieldErrors.durationMinutes)}
            aria-describedby={fieldErrors.durationMinutes ? "na-duration-error" : undefined}
            onChange={(event) => {
              setDuration(event.target.value === "" ? Number.NaN : Number(event.target.value));
              setServerFields({});
            }}
          />
        </Field>
        <Field label="Marks" htmlFor="na-marks" error={fieldErrors.totalMarks}>
          <Input
            id="na-marks"
            type="number"
            min={1}
            max={200}
            value={Number.isNaN(totalMarks) ? "" : totalMarks}
            invalid={Boolean(fieldErrors.totalMarks)}
            aria-describedby={fieldErrors.totalMarks ? "na-marks-error" : undefined}
            onChange={(event) => {
              setTotalMarks(event.target.value === "" ? Number.NaN : Number(event.target.value));
              setServerFields({});
            }}
          />
        </Field>
      </div>

      <div className="ui-row" style={{ marginTop: 14 }}>
        <Button
          variant="primary"
          onClick={create}
          loading={busy}
          loadingLabel="Creating…"
          disabled={hasFieldErrors || !subjectId}
        >
          Start building
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function presetFor(
  grades: Grade[],
  classes: ClassOption[],
  classId: string | undefined,
): { gradeId: string; subjectId: string; classId: string } | null {
  const klass = classId ? classes.find((option) => option.id === classId) : undefined;
  if (!klass) return null;
  for (const grade of grades) {
    if (grade.number !== klass.gradeNumber) continue;
    const subject = grade.subjects.find((option) => option.name === klass.subjectName);
    if (subject) return { gradeId: grade.id, subjectId: subject.id, classId: klass.id };
  }
  return null;
}
