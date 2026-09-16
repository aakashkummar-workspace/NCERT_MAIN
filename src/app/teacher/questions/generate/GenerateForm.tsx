"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Card, Field, Select } from "@/ui";

type Chapter = { id: string; label: string; outcomeCount: number };

type Result = {
  created: string[];
  rejected: { stem: string; reason: string }[];
  costMicros: number;
};

/**
 * Ask for questions, then read what came back.
 *
 * The rejected list is shown, with reasons. It would be tidier to hide it —
 * the drafts that failed are not going in the bank either way — but a teacher
 * deciding whether this feature is worth using needs to see that the filter is
 * doing something, and a silent "3 of 8" is indistinguishable from a bad model.
 */
export function GenerateForm({ chapters }: { chapters: Chapter[] }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setResult(null);

    const data = new FormData(event.currentTarget);

    try {
      const response = await fetch("/api/questions/generate/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chapterId: String(data.get("chapterId") ?? ""),
          count: Number(data.get("count") ?? 4),
          types: [String(data.get("type") ?? "MCQ")],
          difficulty: String(data.get("difficulty") ?? "MEDIUM"),
          marks: Number(data.get("marks") ?? 1),
        }),
      });
      const body = await response.json();

      if (!response.ok) {
        setError(body?.error?.message ?? "We could not generate anything just now.");
        setPending(false);
        return;
      }

      setResult(body);
      setPending(false);
      router.refresh();
    } catch {
      setError("We could not reach the server. Nothing was generated.");
      setPending(false);
    }
  }

  return (
    <>
      <Card
        title="What to write"
        description="One chapter at a time. Grounding works because the context is narrow."
      >
        <form onSubmit={onSubmit}>
          <div className="ui-generate-grid">
            <Field label="Chapter" htmlFor="chapterId">
              <Select id="chapterId" name="chapterId" required>
                {chapters.map((chapter) => (
                  <option key={chapter.id} value={chapter.id}>
                    {chapter.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Type" htmlFor="type">
              <Select id="type" name="type" defaultValue="MCQ">
                <option value="MCQ">Multiple choice</option>
                <option value="TRUE_FALSE">True or false</option>
                <option value="NUMERIC">Numeric answer</option>
                <option value="VSA">Very short answer</option>
                <option value="SA">Short answer</option>
              </Select>
            </Field>

            <Field label="Difficulty" htmlFor="difficulty">
              <Select id="difficulty" name="difficulty" defaultValue="MEDIUM">
                <option value="EASY">Easy</option>
                <option value="MEDIUM">Medium</option>
                <option value="HARD">Hard</option>
              </Select>
            </Field>

            <Field label="How many" htmlFor="count">
              <Select id="count" name="count" defaultValue="4">
                {[2, 4, 6, 8, 10].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Marks each" htmlFor="marks">
              <Select id="marks" name="marks" defaultValue="1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {error && <Alert tone="danger">{error}</Alert>}

          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={pending}
            loadingLabel="Writing… this takes up to a minute"
          >
            Generate drafts
          </Button>
        </form>
      </Card>

      {result && (
        <Card
          title={
            result.created.length === 0
              ? "Nothing made it through"
              : `${result.created.length} draft${result.created.length === 1 ? "" : "s"} saved`
          }
          description={
            result.created.length > 0
              ? "They are in your bank as drafts. Read each one and approve the ones you would set."
              : "Everything the model wrote failed the checks your own questions pass. Try a different difficulty, or write one yourself."
          }
        >
          {result.created.length > 0 && (
            <div className="ui-row" style={{ gap: 10, marginBottom: 14 }}>
              <Link
                href="/teacher/questions"
                className="ui-button"
                data-variant="primary"
              >
                <span>Review them</span>
              </Link>
            </div>
          )}

          {result.rejected.length > 0 && (
            <>
              <h3 className="ui-section-heading">
                Dropped before you saw them ({result.rejected.length})
              </h3>
              <ul className="ui-rejected">
                {result.rejected.map((item, index) => (
                  <li key={index}>
                    <span className="ui-rejected-stem">{item.stem}</span>
                    <span className="ui-rejected-reason">{item.reason}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <p className="ui-hint" style={{ marginTop: 14 }}>
            {/*
              In the unit a teacher is actually charged in. They are never billed
              in dollars per call — their plan meters generations — so a dollar
              figure was our cost, in a currency they do not pay in, read as a
              charge. The dollar cost stays on the platform console.
            */}
            This used one of your plan&apos;s AI generations for the month.
          </p>
        </Card>
      )}
    </>
  );
}
