"use client";

import { useRef, useState } from "react";
import { shrinkPhoto } from "@/app/_photos/shrink";

const MAX_PHOTOS = 3;

/**
 * "Add a photo of your working", under a written answer.
 *
 * A Class 10 proof or a long answer is written in a notebook, not typed on a
 * phone keyboard, so a student can photograph it instead of — or as well as —
 * typing. The photo goes up the moment it is taken.
 *
 * It is NOT queued like a typed answer, and the screen says so rather than
 * pretending: a typed answer is a few hundred bytes the player can keep on
 * the device through a dropped connection; a photo is hundreds of kilobytes,
 * and holding one in localStorage would push out the typed answers that
 * already live there. So a failed upload says it failed, plainly, and the
 * student can take it again — nothing typed is ever put at risk for it.
 *
 * The photo is of the ANSWER. The note under the button asks for exactly
 * that, because a teacher may have a model read it, and a name at the top of
 * a notebook page has no business in that.
 */
export function PhotoAnswer({
  attemptId,
  questionId,
  images,
  onChange,
}: {
  attemptId: string;
  questionId: string;
  images: string[];
  onChange: (images: string[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setProblem(null);
    try {
      const body = await shrinkPhoto(file);
      const response = await fetch(
        `/api/attempts/${attemptId}/images/?question=${encodeURIComponent(questionId)}`,
        { method: "POST", headers: { "Content-Type": "image/jpeg" }, body },
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setProblem(payload?.error?.message ?? "That photo did not go up. Try again.");
      } else {
        onChange([...images, payload.id as string]);
      }
    } catch {
      setProblem(
        "That photo did not go up — the connection dropped. Your typed answer is safe. Take the photo again when you are back online.",
      );
    }
    setBusy(false);
  }

  async function remove(id: string) {
    setProblem(null);
    try {
      const response = await fetch(`/api/answer-images/${id}/`, { method: "DELETE" });
      if (response.ok) onChange(images.filter((image) => image !== id));
      else setProblem("That photo could not be removed.");
    } catch {
      setProblem("That photo could not be removed — the connection dropped.");
    }
  }

  return (
    <div className="ui-photo-answer">
      {images.length > 0 && (
        <ul className="ui-photo-answer-list" aria-label="Photos of your working">
          {images.map((id, index) => (
            <li key={id}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/answer-images/${id}/`} alt={`Photo ${index + 1} of your working`} />
              <button
                type="button"
                className="ui-link-button"
                onClick={() => void remove(id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void upload(file);
        }}
      />
      {images.length < MAX_PHOTOS && (
        <button
          type="button"
          className="ui-button"
          data-variant="secondary"
          data-size="md"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          <span>{busy ? "Sending the photo…" : "Add a photo of your working"}</span>
        </button>
      )}
      <p className="ui-hint">
        Photograph only your answer — not your name. Up to {MAX_PHOTOS} photos. They go up
        straight away, so you need a connection for this part.
      </p>
      {problem && (
        <p className="ui-player-error" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
