"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Avatar, Badge, Button, Card, TrashIcon } from "@/ui";

type Student = {
  userId: string;
  fullName: string;
  phone: string | null;
  rollNumber: string | null;
  joinedAt: Date;
  canSignIn: boolean;
};

export function StudentList({
  classId,
  students,
}: {
  classId: string;
  students: Student[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);

  const filtered = query.trim()
    ? students.filter(
        (student) =>
          student.fullName.toLowerCase().includes(query.toLowerCase()) ||
          (student.rollNumber ?? "").toLowerCase().includes(query.toLowerCase()),
      )
    : students;

  async function remove(student: Student) {
    if (
      !window.confirm(
        `Remove ${student.fullName} from this class?\n\nTheir record and any past results are kept — they simply stop appearing here.`,
      )
    ) {
      return;
    }
    setRemoving(student.userId);
    try {
      await fetch(`/api/classes/${classId}/students/`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentUserId: student.userId }),
      });
      router.refresh();
    } finally {
      setRemoving(null);
    }
  }

  return (
    <Card
      title={`Enrolled Students (${students.length})`}
      action={
        students.length > 5 ? (
          <input
            className="ui-input"
            style={{ width: 220 }}
            placeholder="Search by name or roll..."
            aria-label="Search students"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        ) : undefined
      }
    >
      {filtered.length === 0 ? (
        <p style={{ margin: 0, fontSize: 14, color: "var(--text-secondary)" }}>
          No student matches “{query}”.
        </p>
      ) : (
        <ul className="ui-student-list">
          {filtered.map((student) => (
            <li key={student.userId}>
              <span className="ui-student-roll tabular">
                {student.rollNumber ? `#${student.rollNumber}` : "—"}
              </span>
              <div
                className="ui-roster-person"
                style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}
              >
                <Avatar name={student.fullName} />
                <span className="ui-student-name">{student.fullName}</span>
              </div>
              <span className="ui-student-phone tabular">
                {student.phone ? (
                  <span style={{ fontFamily: "var(--font-mono, monospace)" }}>
                    {student.phone}
                  </span>
                ) : (
                  <Badge tone="warning">No mobile</Badge>
                )}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => remove(student)}
                loading={removing === student.userId}
                loadingLabel="Removing"
              >
                <TrashIcon size={14} />
                <span>Remove</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
