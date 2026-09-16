"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Field, Select } from "@/ui";

export type BoardChoice = { code: string; name: string; authored: boolean };

/**
 * Changing the board.
 *
 * Offered only while the organisation is empty. Once a class, a question or a
 * paper exists, the server refuses — see `core/organizations` for why a
 * refusal rather than a warning — and this component says so up front rather
 * than letting somebody choose and then be told no.
 */
export function BoardCard({
  current,
  boards,
  locked,
}: {
  current: BoardChoice;
  boards: BoardChoice[];
  locked: { classes: number; questions: number; assessments: number } | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setSaved(false);

    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/settings/board/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boardCode: String(data.get("boardCode") ?? "") }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(
          body?.error?.message ??
            "We could not change the board just now. Nothing was saved.",
        );
        setPending(false);
        return;
      }
      setSaved(true);
      setPending(false);
      router.refresh();
    } catch {
      setError("We could not reach the server. Nothing was saved.");
      setPending(false);
    }
  }

  if (locked) {
    return (
      <>
        <dl className="ui-facts">
          <dt>Board</dt>
          <dd>{current.name}</dd>
        </dl>
        <p className="ui-hint" style={{ marginTop: 14 }}>
          Your {describe(locked)} are all built against {current.name}: each one
          points at a grade, subject or chapter that belongs to it. Changing the
          board here would not move them — it would leave every one of them
          pointing at a syllabus you no longer teach, and nothing on screen
          would look wrong until a heatmap came back empty. So it is fixed now.
          Talk to us if you need to move; it is a migration, not a setting.
        </p>
      </>
    );
  }

  return (
    <form onSubmit={onSubmit}>
      {error && <Alert tone="danger">{error}</Alert>}
      {saved && <Alert tone="success">Board changed.</Alert>}

      <Field
        label="Board"
        htmlFor="boardCode"
        hint="Changeable while your organisation is empty. As soon as you create a class, a question or a paper, it is fixed — those all point into this board's syllabus."
      >
        <Select
          id="boardCode"
          name="boardCode"
          defaultValue={current.code}
          aria-describedby="boardCode-hint"
        >
          {boards.map((board) => (
            <option key={board.code} value={board.code} disabled={!board.authored}>
              {board.name}
              {board.authored ? "" : " — syllabus not authored yet"}
            </option>
          ))}
        </Select>
      </Field>

      <Button type="submit" variant="secondary" loading={pending} loadingLabel="Saving…">
        Change board
      </Button>
    </form>
  );
}

function describe(locked: {
  classes: number;
  questions: number;
  assessments: number;
}): string {
  const parts: string[] = [];
  if (locked.classes > 0) {
    parts.push(`${locked.classes} class${locked.classes === 1 ? "" : "es"}`);
  }
  if (locked.questions > 0) {
    parts.push(`${locked.questions} question${locked.questions === 1 ? "" : "s"}`);
  }
  if (locked.assessments > 0) {
    parts.push(
      `${locked.assessments} assessment${locked.assessments === 1 ? "" : "s"}`,
    );
  }
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]!}`;
}
