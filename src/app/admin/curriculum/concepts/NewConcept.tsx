"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { checkConceptName, conceptSlug } from "@/core/curriculum/concept-rules";

/**
 * Creating a concept.
 *
 * The name is checked while it is typed, by the same pure function the server
 * runs on save — one validator, two callers, so "valid" means the same thing in
 * both places and nobody presses a button to meet a refusal they could have
 * been shown.
 *
 * The derived slug is shown rather than hidden: it is the identifier a seed
 * file and a support ticket will use, and somebody authoring a hundred of these
 * should be able to see what they are getting.
 */
export function NewConcept() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problems = name.trim().length > 0 ? checkConceptName(name) : [];
  const errors = problems.filter((problem) => problem.severity === "error");
  const warnings = problems.filter((problem) => problem.severity === "warning");
  const ready = name.trim().length > 0 && errors.length === 0;

  async function create() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/curriculum/concepts/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
        }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        setError(json?.error?.message ?? "We could not create that concept.");
        return;
      }
      setName("");
      setDescription("");
      router.refresh();
    } catch {
      setError("We could not reach the server.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="ui-concept-new">
      <h2 className="ui-platform-heading">Add a concept</h2>
      <div className="ui-concept-new-fields">
        <label className="ui-field">
          <span>Name</span>
          <input
            type="text"
            className="ui-input"
            value={name}
            placeholder="Similarity of triangles"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="ui-field">
          <span>What it means (optional)</span>
          <input
            type="text"
            className="ui-input"
            value={description}
            placeholder="Recognising and using similar triangles"
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
      </div>

      {name.trim().length > 0 && errors.length === 0 && (
        <p className="ui-hint tabular">
          identifier: {conceptSlug(name) || "—"}
        </p>
      )}

      {errors.map((problem) => (
        <p key={problem.message} className="ui-concept-error">
          {problem.message}
        </p>
      ))}
      {/* Advice, not a gate — the same distinction the outcome checker makes. */}
      {warnings.map((problem) => (
        <p key={problem.message} className="ui-concept-warning">
          {problem.message}
        </p>
      ))}
      {error && <p className="ui-concept-error">{error}</p>}

      <div className="ui-report-actions">
        <button
          type="button"
          className="ui-button"
          data-variant="primary"
          data-size="md"
          disabled={!ready || pending}
          onClick={() => void create()}
        >
          <span>{pending ? "Creating…" : "Create concept"}</span>
        </button>
      </div>
    </section>
  );
}
