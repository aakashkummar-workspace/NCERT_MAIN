"use client";

import { useState } from "react";
import { TargetIcon } from "@/ui/icons";
import type { PublicSubject } from "@/core/curriculum/admin";

/**
 * The syllabus, as the product actually holds it.
 *
 * It used to be a hard-coded list, and a hard-coded list is a claim nobody
 * re-checks: Class 9 showed the OLD NCERT books (Number Systems, Matter in Our
 * Surroundings) after the product had moved to Ganita Manjari and Exploration,
 * and every "N Outcomes" badge was a guess. Now the page passes in what is on
 * the curriculum plane, so the explorer can only say what is true — including
 * that the outcomes are drafts waiting for a subject teacher's review.
 */
export function CurriculumExplorer({ subjects }: { subjects: PublicSubject[] }) {
  const [grade, setGrade] = useState<number>(10);
  const [code, setCode] = useState<string>("SCI");

  const current = subjects.find((s) => s.grade === grade && s.code === code);
  const gradeHas = (value: number) => subjects.some((s) => s.grade === value);

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      <div className="ui-landing-curriculum-tabs">
        <div
          role="group"
          aria-label="Class"
          style={{ display: "inline-flex", gap: 4, background: "var(--surface-sunken)", padding: 4, borderRadius: "var(--radius-control)" }}
        >
          {[10, 9].filter(gradeHas).map((value) => (
            <button
              key={value}
              type="button"
              className="ui-landing-tab-btn"
              data-active={grade === value}
              aria-pressed={grade === value}
              onClick={() => setGrade(value)}
            >
              Class {value}
            </button>
          ))}
        </div>

        <div
          role="group"
          aria-label="Subject"
          style={{ display: "inline-flex", gap: 4, background: "var(--surface-sunken)", padding: 4, borderRadius: "var(--radius-control)" }}
        >
          {[
            { value: "SCI", label: "Science" },
            { value: "MATH", label: "Mathematics" },
          ].map((item) => (
            <button
              key={item.value}
              type="button"
              className="ui-landing-tab-btn"
              data-active={code === item.value}
              aria-pressed={code === item.value}
              onClick={() => setCode(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {!current || current.chapters.length === 0 ? (
        <p style={{ textAlign: "center", color: "var(--text-secondary)" }}>
          No chapters are loaded for this subject yet.
        </p>
      ) : (
        <div className="ui-landing-chapters-grid">
          {current.chapters.map((ch) => (
            <div key={ch.number} className="ui-landing-chapter-card">
              <div className="ui-landing-chapter-header">
                <span className="ui-landing-chapter-num">
                  CH {String(ch.number).padStart(2, "0")}
                </span>
                <span
                  style={{
                    fontSize: 12,
                    color: "var(--text-secondary)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    fontWeight: 500,
                  }}
                >
                  <TargetIcon size={13} />
                  {ch.outcomes === 0
                    ? "Outcomes not written yet"
                    : `${ch.outcomes} ${new Intl.PluralRules("en-IN").select(ch.outcomes) === "one" ? "outcome" : "outcomes"}${
                        ch.reviewedOutcomes < ch.outcomes ? " · draft" : ""
                      }`}
                </span>
              </div>

              <div className="ui-landing-chapter-name">{ch.title}</div>

              {ch.concepts.length > 0 && (
                <div className="ui-landing-chapter-concepts">
                  {ch.concepts.map((c) => (
                    <span key={c} className="ui-landing-concept-tag">
                      {c}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <p style={{ textAlign: "center", fontSize: 13, color: "var(--text-secondary)", marginTop: 20 }}>
        Chapters follow the current NCERT books. Learning outcomes marked
        &ldquo;draft&rdquo; were written against the books and are waiting for
        review by a subject teacher.
      </p>
    </div>
  );
}
