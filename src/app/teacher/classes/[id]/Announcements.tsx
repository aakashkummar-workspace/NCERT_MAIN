"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, TrashIcon } from "@/ui";
import { formatDateTime } from "@/i18n/format";

/**
 * A class's announcements, on the class page.
 *
 * Posting refreshes the page rather than splicing a row in locally, so the list
 * a teacher sees after pressing Post is the list the server holds — the same
 * list thirty students are about to see on their home pages.
 *
 * The body is rendered as a text node. `white-space: pre-line` keeps the line
 * breaks the teacher typed; nothing here ever interprets it as markup.
 */

/** Mirrors ANNOUNCEMENT_MAX_LENGTH in core — a client component cannot import it. */
const MAX_LENGTH = 1000;

export type AnnouncementItem = {
  id: string;
  body: string;
  createdAt: Date;
  authorName: string | null;
};

const RELATIVE = new Intl.RelativeTimeFormat("en-IN", { numeric: "auto" });

/**
 * Relative to the server's `now`, not the device clock, so the server render
 * and the hydrated one agree to the character.
 */
function relative(date: Date, now: Date): string {
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return "just now";
  if (abs < 3600) return RELATIVE.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return RELATIVE.format(Math.round(seconds / 3600), "hour");
  if (abs < 30 * 86_400) return RELATIVE.format(Math.round(seconds / 86_400), "day");
  return RELATIVE.format(Math.round(seconds / (30 * 86_400)), "month");
}

export function Announcements({
  classId,
  className,
  items,
  truncated,
  canPost,
  now,
}: {
  classId: string;
  className: string;
  items: AnnouncementItem[];
  truncated: boolean;
  canPost: boolean;
  now: Date;
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Counted the way the server counts: trimmed, one character per line break.
  const length = body.replace(/\r\n?/g, "\n").trim().length;
  const over = length > MAX_LENGTH;

  async function post() {
    if (length === 0 || over || posting) return;
    setPosting(true);
    setError(null);
    try {
      const response = await fetch(`/api/classes/${classId}/announcements/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        setError(json?.error?.message ?? "That did not post. Try again.");
        return;
      }
      setBody("");
      router.refresh();
    } catch {
      setError("We could not reach the server. Your message is still in the box — try again.");
    } finally {
      setPosting(false);
    }
  }

  async function remove(item: AnnouncementItem) {
    if (
      !window.confirm(
        "Remove this announcement?\n\nStudents stop seeing it on their home page straight away.",
      )
    ) {
      return;
    }
    setRemoving(item.id);
    setError(null);
    try {
      const response = await fetch(`/api/announcements/${item.id}/`, { method: "DELETE" });
      if (!response.ok) {
        const json = await response.json().catch(() => null);
        setError(json?.error?.message ?? "That did not remove. Try again.");
        return;
      }
      router.refresh();
    } catch {
      setError("We could not reach the server. Check your connection and try again.");
    } finally {
      setRemoving(null);
    }
  }

  return (
    <Card
      title="Announcements"
      description="A short note to everyone in this class. Students see it on their home page."
    >
      {canPost && (
        <div className="ui-ann-compose">
          <label className="ui-label" htmlFor="announcement-body">
            Message
          </label>
          <textarea
            id="announcement-body"
            className="ui-textarea ui-ann-textarea"
            rows={3}
            value={body}
            aria-invalid={over || undefined}
            aria-describedby="announcement-count"
            placeholder="For example: Monday's test covers chapters 1 and 2."
            onChange={(event) => setBody(event.target.value)}
          />
          <div className="ui-ann-compose-foot">
            <span
              id="announcement-count"
              className="ui-ann-count tabular"
              data-over={over || undefined}
              aria-live="polite"
            >
              {length} / {MAX_LENGTH}
            </span>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void post()}
              disabled={length === 0 || over}
              loading={posting}
              loadingLabel="Posting"
            >
              Post to {className}
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p className="ui-error ui-ann-error" role="alert">
          {error}
        </p>
      )}

      {items.length === 0 ? (
        <p className="ui-ann-empty">
          Nothing posted yet. Anything you post here appears on the home page of
          every student enrolled in {className}, for 30 days.
        </p>
      ) : (
        <ul className="ui-ann-list">
          {items.map((item) => (
            <li key={item.id} className="ui-ann-item">
              <p className="ui-ann-body">{item.body}</p>
              <div className="ui-ann-meta">
                <span>
                  {item.authorName ? `${item.authorName} · ` : ""}
                  <time
                    dateTime={item.createdAt.toISOString()}
                    title={formatDateTime("en-IN", item.createdAt)}
                  >
                    {relative(item.createdAt, now)}
                  </time>
                  <span className="ui-ann-absolute">
                    {" "}
                    · {formatDateTime("en-IN", item.createdAt)}
                  </span>
                </span>
                {canPost && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void remove(item)}
                    loading={removing === item.id}
                    loadingLabel="Removing"
                    aria-label={`Remove announcement posted ${relative(item.createdAt, now)}`}
                  >
                    <TrashIcon size={14} />
                    <span>Remove</span>
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {truncated && (
        <p className="ui-hint ui-ann-truncated">
          Showing the {items.length} most recent. Older announcements are kept but
          not listed here.
        </p>
      )}
    </Card>
  );
}
