"use client";

import { useState } from "react";
import { SparklesIcon, CheckIcon, AlertTriangleIcon, ArrowRightIcon } from "@/ui/icons";
import Link from "next/link";

const SAMPLE_QUESTION = {
  subject: "CBSE Class 10 Science",
  chapter: "Light — Reflection and Refraction",
  concept: "Concave Mirror: Image Formation & Magnification",
  stem: "An object is placed at a distance of 20 cm in front of a concave mirror of focal length 15 cm. What is the nature and magnification (m) of the image formed?",
  options: [
    {
      id: "A",
      label: "A",
      text: "Real, inverted, and magnified (m = -3)",
      isCorrect: true,
      explanation: "Using mirror formula 1/f = 1/v + 1/u: with f = -15 cm and u = -20 cm, 1/v = -1/15 - (-1/20) = -1/60 cm⁻¹. Thus v = -60 cm. Magnification m = -v/u = -(-60)/(-20) = -3. Since m is negative, the image is real and inverted, and |m| > 1 means magnified.",
      diagnosis: "Correct — and still one answer. It becomes evidence for the concept, but no band is shown until enough marked answers agree.",
    },
    {
      id: "B",
      label: "B",
      text: "Virtual, erect, and magnified (m = +3)",
      isCorrect: false,
      explanation: "A concave mirror only forms a virtual, erect image when the object is placed between Pole and Principal Focus (u < 15 cm). Here u = 20 cm, which is between F and C.",
      diagnosis: "A wrong answer the student can retry from their 'Things to fix' list. It only counts as fixed when they get a DIFFERENT question on the same idea right — retrying this one is not proof.",
    },
    {
      id: "C",
      label: "C",
      text: "Real, inverted, and diminished (m = -0.75)",
      isCorrect: false,
      explanation: "You may have applied the lens formula (1/f = 1/v - 1/u) instead of the mirror formula (1/f = 1/v + 1/u), or inverted the magnification ratio as u/v.",
      diagnosis: "Likely a mirror-versus-lens formula mix-up — but one answer cannot tell a misconception from a slip. Practice on this concept is offered once there is enough evidence to say it is weak.",
    },
    {
      id: "D",
      label: "D",
      text: "Virtual, erect, and diminished (m = +0.75)",
      isCorrect: false,
      explanation: "A virtual, erect, and diminished image is formed by a CONVEX mirror, never by a concave mirror for real objects.",
      diagnosis: "Possibly confusing concave and convex mirrors. The teacher sees it on the class results; nothing is concluded about the student from a single answer.",
    },
  ],
};

/**
 * One sample question, answered on the landing page.
 *
 * It used to announce "Mastery Confirmed: Secure" after a single tap — the one
 * claim the product itself refuses to make below its evidence threshold. So the
 * demo now says what the product would: one answer is evidence, not a verdict,
 * and the mastery line reads "not enough evidence yet" whatever is chosen.
 */
export function InteractiveDemo() {
  const [selected, setSelected] = useState<string | null>(null);

  const selectedOpt = SAMPLE_QUESTION.options.find((o) => o.id === selected);

  return (
    <div className="ui-landing-demo-box">
      <div className="ui-landing-demo-badge">
        <SparklesIcon size={14} />
        <span>Interactive Diagnostic Demo · {SAMPLE_QUESTION.subject}</span>
      </div>

      <div style={{ marginBottom: 12, fontSize: 13, color: "var(--text-tertiary)" }}>
        Chapter: <strong>{SAMPLE_QUESTION.chapter}</strong> · Concept:{" "}
        <span style={{ color: "var(--accent)" }}>{SAMPLE_QUESTION.concept}</span>
      </div>

      <p className="ui-landing-demo-q">{SAMPLE_QUESTION.stem}</p>

      <div className="ui-landing-demo-options">
        {SAMPLE_QUESTION.options.map((opt) => {
          const isThisSelected = selected === opt.id;
          let state: "correct" | "incorrect" | undefined;
          if (selected) {
            if (opt.isCorrect) state = "correct";
            else if (isThisSelected) state = "incorrect";
          }

          return (
            <button
              key={opt.id}
              type="button"
              className="ui-landing-demo-opt"
              data-selected={isThisSelected}
              data-state={state}
              onClick={() => setSelected(opt.id)}
            >
              <strong
                style={{
                  width: 22,
                  height: 22,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 4,
                  background: isThisSelected ? "var(--accent)" : "var(--surface-sunken)",
                  color: isThisSelected ? "#fff" : "var(--text-secondary)",
                  fontSize: 12,
                  flex: "none",
                }}
              >
                {opt.label}
              </strong>
              <span>{opt.text}</span>
            </button>
          );
        })}
      </div>

      {selectedOpt && (
        <div
          className="ui-landing-demo-feedback"
          data-state={selectedOpt.isCorrect ? "correct" : "incorrect"}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            {selectedOpt.isCorrect ? (
              <>
                <CheckIcon size={18} />
                <strong style={{ fontSize: 15 }}>Correct Solution</strong>
              </>
            ) : (
              <>
                <AlertTriangleIcon size={18} />
                <strong style={{ fontSize: 15, color: "var(--danger)" }}>
                  How Sahayak Diagnoses This Wrong Answer
                </strong>
              </>
            )}
          </div>

          <p style={{ margin: "0 0 10px", color: "var(--text-primary)" }}>
            {selectedOpt.explanation}
          </p>

          <div
            style={{
              padding: "10px 14px",
              borderRadius: "var(--radius-sm)",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              fontSize: 13,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 10,
            }}
          >
            <div>
              <span
                style={{ display: "block", marginBottom: 6, color: "var(--text-primary)" }}
              >
                <strong>Mastery for this concept:</strong> not enough evidence yet
              </span>
              <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                What happens next:{" "}
              </span>
              <span style={{ color: "var(--text-secondary)" }}>
                {selectedOpt.diagnosis}
              </span>
            </div>
            <Link
              href="/signup"
              className="ui-button"
              data-variant="primary"
              data-size="sm"
            >
              <span>See in Action</span>
              <ArrowRightIcon size={14} />
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
