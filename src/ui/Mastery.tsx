import type { ReactNode } from "react";

/**
 * The mastery display components.
 *
 * These take a band and an estimate that may be null, and they cannot fetch
 * anything — `src/ui` never imports `@/core`. That is what makes the refusal
 * rule structural rather than a convention: `core/mastery` returns null for an
 * estimate it will not stand behind, the column is null, and by the time a
 * value reaches this file there is nothing to leak.
 *
 * The five bands are the reserved scale from DESIGN_SYSTEM.md section 2.4. The
 * fifth is not a low score — it is a refusal, and it is rendered as words
 * rather than as a bar at zero, because an empty bar reads as "nothing" and
 * "we don't know" is a different statement entirely.
 */

export type MasteryBand =
  | "CRITICAL"
  | "FRAGILE"
  | "DEVELOPING"
  | "SECURE"
  | "INSUFFICIENT";

export const BAND_LABEL: Record<MasteryBand, string> = {
  SECURE: "You've got this",
  DEVELOPING: "Almost there",
  FRAGILE: "Needs practice",
  CRITICAL: "Let's start here",
  INSUFFICIENT: "Not enough evidence yet",
};

export function MasteryBar({
  band,
  estimate,
  label,
}: {
  band: MasteryBand;
  /** Null whenever the band is INSUFFICIENT. */
  estimate: number | null;
  label?: string;
}) {
  if (band === "INSUFFICIENT" || estimate === null) {
    return (
      <p className="ui-mastery-unknown">
        {BAND_LABEL.INSUFFICIENT}
        {label ? ` — ${label}` : ""}
      </p>
    );
  }

  // Floored through the thousandths, exactly as `displayPercent` in
  // core/analytics/class.ts does (duplicated because a component may not import
  // core): the bands start on whole percentages, so 0.595 rounded to 60 printed
  // a "needs practice" bar labelled with the number that is the line itself.
  const percent = Math.floor(Math.round(estimate * 1000) / 10);

  return (
    <div className="ui-mastery">
      <div
        className="ui-mastery-track"
        role="img"
        aria-label={`${BAND_LABEL[band]}, ${percent} per cent`}
      >
        <span
          className="ui-mastery-fill"
          data-band={band}
          style={{ width: `${percent}%` }}
        />
      </div>
      {/* Always a number beside the bar. A bar alone is a shape, and two bars
          a teacher is comparing need to differ by something readable. */}
      <span className="ui-mastery-value tabular">{percent}%</span>
    </div>
  );
}

export function MasteryChip({ band }: { band: MasteryBand }) {
  return (
    <span className="ui-mastery-chip" data-band={band}>
      {BAND_LABEL[band]}
    </span>
  );
}

export type MasteryTrend = "IMPROVING" | "STABLE" | "DECLINING" | "UNKNOWN";

const TREND_GLYPH: Record<MasteryTrend, string> = {
  IMPROVING: "↑",
  DECLINING: "↓",
  STABLE: "→",
  UNKNOWN: "",
};

const TREND_LABEL: Record<MasteryTrend, string> = {
  IMPROVING: "Improving",
  DECLINING: "Slipping",
  STABLE: "Holding steady",
  UNKNOWN: "",
};

export function TrendMark({ trend }: { trend: MasteryTrend }) {
  // Nothing at all rather than a dash. There is no arrow for "we have not
  // measured twice yet", and inventing one would make a first sitting look
  // like a flat result.
  if (trend === "UNKNOWN") return null;
  return (
    <span className="ui-trend" data-trend={trend}>
      <span aria-hidden="true">{TREND_GLYPH[trend]}</span>
      <span>{TREND_LABEL[trend]}</span>
    </span>
  );
}

export function MasteryCard({
  title,
  where,
  band,
  estimate,
  evidenceCount,
  needed,
  trend,
  footer,
}: {
  title: string;
  where?: string;
  band: MasteryBand;
  estimate: number | null;
  evidenceCount: number;
  /** How many answers the estimator needs before it will say anything. */
  needed?: number;
  trend: MasteryTrend;
  footer?: ReactNode;
}) {
  const unmeasured = band === "INSUFFICIENT" || estimate === null;

  return (
    <article className="ui-mastery-card">
      <div className="ui-mastery-head">
        <div>
          <h3 className="ui-mastery-title">{title}</h3>
          {where && <p className="ui-mastery-where">{where}</p>}
        </div>
        <MasteryChip band={band} />
      </div>

      {/*
        Said once. The chip already carries the refusal; repeating it in the
        body and again in the count is three statements of one fact, and a
        reader learns to skip all three. What is missing instead is what would
        change it — how many more answers this needs.
      */}
      {unmeasured ? (
        <p className="ui-mastery-unknown">
          {evidenceCount === 0
            ? "You have not answered anything on this yet."
            : needed && needed > evidenceCount
              ? `${evidenceCount} of ${needed} answers so far.`
              : `${evidenceCount} ${evidenceCount === 1 ? "answer" : "answers"} so far, and all of it is old.`}
        </p>
      ) : (
        <>
          <MasteryBar band={band} estimate={estimate} />
          <p className="ui-mastery-meta">
            <span className="tabular">
              {evidenceCount} {evidenceCount === 1 ? "answer" : "answers"}
            </span>
            <TrendMark trend={trend} />
          </p>
        </>
      )}

      {footer}
    </article>
  );
}
