"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { classNameContradictsGrade } from "@/core/classes/name-check";
import { Alert, Button, Field, Input, Select } from "@/ui";

type Grade = {
  id: string;
  number: number;
  label: string;
  subjects: { id: string; name: string; shortName: string }[];
};

export function CreateClassForm({
  grades,
  defaultAcademicYear,
}: {
  grades: Grade[];
  defaultAcademicYear: string;
}) {
  const router = useRouter();
  const [gradeId, setGradeId] = useState(grades[0]?.id ?? "");
  const [subjectId, setSubjectId] = useState(grades[0]?.subjects[0]?.id ?? "");
  const [name, setName] = useState(grades[0] ? `${grades[0].label}-A` : "");
  const [academicYear, setAcademicYear] = useState(defaultAcademicYear);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const grade = grades.find((g) => g.id === gradeId);
  const subjects = grade?.subjects ?? [];

  /**
   * Changing the year must change the subject too: subjects belong to a grade,
   * and the server rejects a mismatched pair. Fixing it here means the teacher
   * never meets that error.
   */
  function onGradeChange(next: string) {
    const nextGrade = grades.find((g) => g.id === next);
    setGradeId(next);
    setSubjectId(nextGrade?.subjects[0]?.id ?? "");
    // The suggested name follows the year — unless the teacher has typed
    // something of their own, which is theirs to keep.
    setName((current) =>
      current === "" || /^Class \d+-A$/.test(current)
        ? `${nextGrade?.label ?? ""}-A`
        : current,
    );
  }

  /**
   * Warned, never blocked: the name belongs to the teacher, the curriculum
   * does not. A group called "Class 10-A" filed against Class 9 would have
   * every later mastery number measured against the wrong syllabus, and
   * nothing downstream would look wrong.
   */
  const nameMismatch =
    grade && classNameContradictsGrade(name, grade.number)
      ? `You named this “${name}”, but the class year above is ${grade.label}. Results are filed against ${grade.label}, whatever the name says.`
      : null;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/classes/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, gradeId, subjectId, academicYear }),
      });

      const body = await response.json();

      if (!response.ok) {
        setError(
          body?.error?.message ??
            "We could not create the class just now. Nothing was saved — please try again.",
        );
        setPending(false);
        return;
      }

      // Straight to the roster: a class with no students does nothing, and
      // filling it is always the next thing the teacher wants.
      router.push(`/teacher/classes/${body.id}`);
      router.refresh();
    } catch {
      setError(
        "We could not reach the server. The class was not created — check your connection and try again.",
      );
      setPending(false);
    }
  }

  return (
    <form className="ui-auth-form" onSubmit={onSubmit} noValidate>
      {error && <Alert tone="danger">{error}</Alert>}

      <Field label="Class year" htmlFor="gradeId">
        <Select
          id="gradeId"
          name="gradeId"
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

      <Field label="Subject" htmlFor="subjectId">
        <Select
          id="subjectId"
          name="subjectId"
          value={subjectId}
          onChange={(event) => setSubjectId(event.target.value)}
        >
          {subjects.map((subject) => (
            <option key={subject.id} value={subject.id}>
              {subject.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="Class name"
        htmlFor="name"
        hint="What you call this group. The section letter is usually enough."
      >
        <Input
          id="name"
          name="name"
          required
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-describedby="name-hint"
        />
      </Field>

      {nameMismatch && <Alert tone="warning">{nameMismatch}</Alert>}

      <Field
        label="Academic year"
        htmlFor="academicYear"
        hint="Runs April to March."
      >
        <Input
          id="academicYear"
          name="academicYear"
          required
          value={academicYear}
          onChange={(event) => setAcademicYear(event.target.value)}
          aria-describedby="academicYear-hint"
        />
      </Field>

      <Button
        type="submit"
        variant="primary"
        size="lg"
        loading={pending}
        loadingLabel="Creating the class…"
      >
        Create class
      </Button>
    </form>
  );
}
