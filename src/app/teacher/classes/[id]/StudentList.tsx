"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Avatar, Badge, Button, Card, TrashIcon } from "@/ui";

/**
 * What the product knows about a student's learning, for their roster row.
 *
 * Counts by band and the weakest concept by name, never an overall score — the
 * same shape as the students index, from the same function. `measured` is the
 * denominator; at zero there is nothing to say, and the row says that rather
 * than printing a number.
 */
export type RosterStatus = {
  measured: number;
  struggling: number;
  secure: number;
  weakest: { name: string; percent: number } | null;
};

type Student = {
  userId: string;
  fullName: string;
  phone: string | null;
  rollNumber: string | null;
  joinedAt: Date;
  canSignIn: boolean;
  hasCard: boolean;
};

export function StudentList({
  classId,
  students,
  status,
}: {
  classId: string;
  students: Student[];
  status: Record<string, RosterStatus>;
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
                <span className="ui-roster-text">
                  <Link
                    href={`/teacher/students/${student.userId}`}
                    className="ui-student-name ui-roster-name"
                  >
                    {student.fullName}
                  </Link>
                  <RosterLine status={status[student.userId]} />
                </span>
              </div>
              <span className="ui-student-phone tabular">
                {student.phone ? (
                  <span style={{ fontFamily: "var(--font-mono, monospace)" }}>
                    {student.phone}
                  </span>
                ) : student.hasCard ? (
                  <Badge tone="neutral">Sign-in card</Badge>
                ) : (
                  <Badge tone="warning">No mobile or card</Badge>
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

function RosterLine({ status }: { status: RosterStatus | undefined }) {
  if (!status || status.measured === 0) {
    // Not a zero: nothing has been marked on them yet, which is a statement
    // about the marking, not about the student.
    return <span className="ui-roster-status">Nothing measured yet</span>;
  }
  return (
    <span className="ui-roster-status">
      {status.struggling > 0 && <Badge tone="danger">{status.struggling} to work on</Badge>}
      {status.secure > 0 && <Badge tone="success">{status.secure} secure</Badge>}
      {status.weakest && (
        <span>
          Weakest: {status.weakest.name}{" "}
          <span className="tabular">({status.weakest.percent}%)</span>
        </span>
      )}
    </span>
  );
}
