"use client";

import Link from "next/link";
import { useState } from "react";
import { EmptyState } from "@/ui";

/**
 * The saved list, with Unsave.
 *
 * A row leaves the moment Unsave is pressed and comes back if the server
 * refuses. Kept in local state rather than refreshed from the server, so the
 * rows around it do not jump while a student is reading them.
 */

export type SavedItem = {
  questionId: string;
  stem: string;
  options: { key: string; text: string }[] | null;
  subjectName: string;
  chapterTitle: string | null;
  savedLabel: string;
  review: { kind: "mistake" | "result" | "practice"; href: string } | null;
};

const REVIEW_LABEL: Record<NonNullable<SavedItem["review"]>["kind"], string> = {
  mistake: "Open in Things to fix",
  result: "Review it in your result",
  practice: "Open the practice set",
};

export function SavedList({ rows: initialRows }: { rows: SavedItem[] }) {
  const [rows, setRows] = useState(initialRows);
  const [error, setError] = useState<string | null>(null);

  async function unsave(item: SavedItem) {
    const index = rows.findIndex((row) => row.questionId === item.questionId);
    setRows((current) => current.filter((row) => row.questionId !== item.questionId));
    setError(null);
    const restore = () =>
      setRows((current) =>
        current.some((row) => row.questionId === item.questionId)
          ? current
          : [...current.slice(0, index), item, ...current.slice(index)],
      );
    try {
      const response = await fetch(`/api/saved/${item.questionId}/`, { method: "DELETE" });
      if (!response.ok) {
        restore();
        setError("That did not unsave. Try again.");
      }
    } catch {
      restore();
      setError("We could not reach the server. Check your connection and try again.");
    }
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        title="Nothing saved yet"
        body="Save a question from a result, practice or Things to fix to come back to it here."
      />
    );
  }

  return (
    <>
      {error && (
        <p className="ui-error ui-saved-error" role="alert">
          {error}
        </p>
      )}
      <ul className="ui-saved-list">
        {rows.map((item) => (
          <li key={item.questionId} className="ui-saved-item">
            <p className="ui-saved-meta">
              {item.subjectName}
              {item.chapterTitle && <> · {item.chapterTitle}</>}
            </p>
            <p className="ui-saved-stem">{item.stem}</p>
            {item.options && item.options.length > 0 && (
              <ul className="ui-saved-options">
                {item.options.map((option) => (
                  <li key={option.key}>
                    <span className="ui-saved-key">{option.key}</span>
                    <span>{option.text}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="ui-saved-foot">
              <span className="ui-saved-date">Saved {item.savedLabel}</span>
              <span className="ui-saved-actions">
                {item.review && (
                  <Link
                    href={item.review.href}
                    className="ui-button"
                    data-variant="secondary"
                    data-size="sm"
                  >
                    <span>{REVIEW_LABEL[item.review.kind]}</span>
                  </Link>
                )}
                <button
                  type="button"
                  className="ui-button"
                  data-variant="ghost"
                  data-size="sm"
                  aria-label={`Unsave: ${item.stem.slice(0, 60)}`}
                  onClick={() => void unsave(item)}
                >
                  <span>Unsave</span>
                </button>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
