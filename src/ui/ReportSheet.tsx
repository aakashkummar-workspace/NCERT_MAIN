/**
 * A term report, rendered.
 *
 * ---------------------------------------------------------------------------
 * Its props are declared here, not imported from core
 * ---------------------------------------------------------------------------
 * `src/ui` may not import `@/core/*` — a component receives data, it does not
 * fetch it — and that rule is doing real work in this particular file. The same
 * sheet is rendered on the teacher's side, which reads `core/reports`, and on
 * the parent's, which may only read `core/parent/read.ts`. A shared component
 * that imported either would drag one surface's reader into the other's scope.
 *
 * So the shape is declared structurally, and both callers satisfy it.
 *
 * ---------------------------------------------------------------------------
 * The payload is rendered as stored, and its version is checked
 * ---------------------------------------------------------------------------
 * A report written in September is read in December by code that has changed
 * since. `payloadVersion` says which shape it is in, and a version this build
 * does not know renders as a plain statement rather than as a half-drawn sheet
 * with fields missing — a document with holes in it is worse than one that says
 * it cannot be shown here.
 *
 * "Does not know" means NEWER. An older payload renders, with what it lacks
 * treated as absent: every version has only ever ADDED optional facts, and
 * refusing to draw a sheet stamped before the last deploy would make the
 * product forget documents it had already handed to parents. A newer one is
 * the case that must refuse — this build cannot know what it would be leaving
 * out.
 */

export const KNOWN_PAYLOAD_VERSION = 2;

export type ReportSheetConcept = {
  conceptId: string;
  conceptName: string;
  estimate: number | null;
  evidenceCount: number;
};

export type ReportSheetMovement = {
  conceptId: string;
  conceptName: string;
  from: number;
  to: number;
};

export type ReportSheetSitting = {
  assignmentId: string;
  title: string;
  subjectName: string;
  satAt: string | Date;
  attempts: number;
  percentage: number | null;
  awarded: number | null;
  total: number | null;
  /** Optional: payload version 1 carried no series. */
  seriesId?: string | null;
  seriesName?: string | null;
};

export type ReportSheetPayload = {
  studentName: string;
  className: string | null;
  periodStart: string;
  periodEnd: string;
  coverage: { measured: number; unmeasured: number };
  standing: { secure: number; developing: number; needsWork: number };
  strengths: ReportSheetConcept[];
  attention: ReportSheetConcept[];
  improved: ReportSheetMovement[];
  slipped: ReportSheetMovement[];
  sittings: ReportSheetSitting[];
  awaitingMarking: number;
  summary: string;
  suggestions: string[];
};

/**
 * The school's letterhead, as it was stamped when the report was written.
 *
 * Structural, like the payload: `core/branding`'s `Letterhead` satisfies it.
 */
export type ReportSheetLetterhead = {
  name: string;
  tagline: string | null;
  address: string | null;
  affiliationNumber: string | null;
  schoolCode: string | null;
  principalName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  website: string | null;
  reportFooter: string | null;
  signatories: string[];
  hidePoweredBy: boolean;
};

export type ReportSheetSittingGroup = {
  seriesId: string | null;
  seriesName: string | null;
  sittings: ReportSheetSitting[];
};

/**
 * The papers, grouped by the series they belonged to.
 *
 * Grouping is PRESENTATION and is derived here rather than stored twice: the
 * payload holds one row per paper carrying the series it was part of, exactly
 * as it holds two integers for coverage rather than a ratio. A stored document
 * should hold facts.
 *
 * Groups run in the order the papers were sat, and papers in no series come
 * last. A report with no series at all produces one unnamed group, which
 * renders as the plain table it always was — a school that never makes a
 * series sees no change.
 *
 * There is no group total, and no field for one: six papers out of different
 * totals, some part marked, cannot honestly become a number, and a report card
 * is where that number would do the most damage.
 */
export function groupBySeries(
  sittings: ReportSheetSitting[],
): ReportSheetSittingGroup[] {
  const groups = new Map<string, ReportSheetSittingGroup>();
  const loose: ReportSheetSitting[] = [];

  for (const sitting of sittings) {
    if (!sitting.seriesId) {
      loose.push(sitting);
      continue;
    }
    const existing = groups.get(sitting.seriesId);
    if (existing) {
      existing.sittings.push(sitting);
      continue;
    }
    groups.set(sitting.seriesId, {
      seriesId: sitting.seriesId,
      // Stamped on the sitting, so a rename since cannot move it.
      seriesName: sitting.seriesName ?? null,
      sittings: [sitting],
    });
  }

  if (groups.size === 0) {
    return [{ seriesId: null, seriesName: null, sittings: sittings }];
  }

  const when = (group: ReportSheetSittingGroup) =>
    Math.min(
      ...group.sittings.map((sitting) =>
        new Date(sitting.satAt).getTime(),
      ),
    );
  const ordered = [...groups.values()].sort((a, b) => when(a) - when(b));
  if (loose.length > 0) {
    ordered.push({ seriesId: null, seriesName: null, sittings: loose });
  }
  return ordered;
}

const DATE = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function on(value: string | Date): string {
  return DATE.format(typeof value === "string" ? new Date(value) : value);
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * How many concepts each named list leaves out.
 *
 * Exported so a test can hold it against what `buildReport` actually names.
 */
export function unnamedCounts(
  payload: Pick<ReportSheetPayload, "coverage" | "standing" | "strengths" | "attention">,
): { attentionUnnamed: number; strengthsUnnamed: number } {
  return {
    attentionUnnamed: Math.max(0, payload.standing.needsWork - payload.attention.length),
    strengthsUnnamed: Math.max(
      0,
      payload.coverage.measured - payload.standing.needsWork - payload.strengths.length,
    ),
  };
}

/** "And 1 more, not named here" — a truncated list says it is truncated. */
function Unnamed({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <p className="ui-report-note">
      {count === 1
        ? "And 1 more idea in this group, not named on this sheet."
        : `And ${count} more ideas in this group, not named on this sheet.`}
    </p>
  );
}

export function ReportSheet({
  payload,
  payloadVersion,
  generatedAt,
  organizationName,
  superseded = false,
  letterhead = null,
  letterheadLogoUrl = null,
}: {
  payload: ReportSheetPayload;
  payloadVersion: number;
  generatedAt: string | Date;
  organizationName: string;
  superseded?: boolean;
  letterhead?: ReportSheetLetterhead | null;
  letterheadLogoUrl?: string | null;
}) {
  if (payloadVersion > KNOWN_PAYLOAD_VERSION) {
    return (
      <section className="ui-report">
        <p className="ui-report-stale">
          This report was written in a newer format than this version of the
          site can display. Ask the school for a fresh one — the original is
          not lost.
        </p>
      </section>
    );
  }

  // Each list names at most a few concepts, and the sheet used to stop there
  // silently: "4 need work" above three names. The counts that make the gap
  // derivable were always in the payload — every measured concept is either
  // below the line or not — so this needs no new field and no version bump,
  // and reports already written say it too.
  const { attentionUnnamed, strengthsUnnamed } = unnamedCounts(payload);

  // Whether any paper on this sheet belonged to a named event. Version 1
  // payloads carry none, so they render exactly as they did before.
  const named = payload.sittings.some((sitting) => Boolean(sitting.seriesId));

  return (
    <article className="ui-report">
      {letterhead && <LetterheadBlock letterhead={letterhead} logoUrl={letterheadLogoUrl} />}

      <header className="ui-report-head">
        <div>
          {/* The letterhead already names the school; saying it twice is noise. */}
          {!letterhead && <p className="ui-report-org">{organizationName}</p>}
          <h1 className="ui-report-name">{payload.studentName}</h1>
          <p className="ui-report-period">
            {payload.className ? `${payload.className} · ` : ""}
            {on(payload.periodStart)} to {on(payload.periodEnd)}
          </p>
        </div>
        <p className="ui-report-issued">Written {on(generatedAt)}</p>
      </header>

      {superseded && (
        // Said plainly rather than hidden. An old sheet is still a true record
        // of what was said on the day, and it must stay readable — but nobody
        // should act on it thinking it is current.
        <p className="ui-report-superseded">
          A newer report has been written since this one. This is kept as a
          record of what was said at the time.
        </p>
      )}

      {/*
        Coverage first, above the marks, always. "Secure on 2 of 5 measured" and
        "secure on 2 of the 40 ideas in the syllabus" are wildly different
        statements about a child, and a report that leads with performance lets
        a reader take a term's worth of confidence from four questions.
      */}
      <section className="ui-report-block">
        <h2 className="ui-report-heading">What we have measured</h2>
        <div className="ui-report-figures">
          <p className="ui-report-figure">
            <span className="ui-report-figure-value tabular">
              {payload.coverage.measured}
            </span>
            <span className="ui-report-figure-label">
              ideas measured
              {payload.coverage.unmeasured > 0 &&
                ` of ${payload.coverage.measured + payload.coverage.unmeasured}`}
            </span>
          </p>
          <p className="ui-report-figure">
            <span className="ui-report-figure-value tabular">
              {payload.standing.secure}
            </span>
            <span className="ui-report-figure-label">secure</span>
          </p>
          <p className="ui-report-figure">
            <span className="ui-report-figure-value tabular">
              {payload.standing.needsWork}
            </span>
            <span className="ui-report-figure-label">need work</span>
          </p>
        </div>
        <p className="ui-report-summary">{payload.summary}</p>
      </section>

      {payload.strengths.length > 0 && (
        <section className="ui-report-block">
          <h2 className="ui-report-heading">Going well</h2>
          <ul className="ui-report-concepts">
            {payload.strengths.map((concept) => (
              <li key={concept.conceptId}>
                <span>{concept.conceptName}</span>
                {/* The number and its denominator travel together, always. */}
                <span className="ui-report-concept-figure tabular">
                  {concept.estimate === null
                    ? "—"
                    : `${percent(concept.estimate)} over ${concept.evidenceCount}`}
                </span>
              </li>
            ))}
          </ul>
          <Unnamed count={strengthsUnnamed} />
        </section>
      )}

      {payload.attention.length > 0 && (
        <section className="ui-report-block">
          <h2 className="ui-report-heading">Needs attention</h2>
          <ul className="ui-report-concepts" data-tone="attention">
            {payload.attention.map((concept) => (
              <li key={concept.conceptId}>
                <span>{concept.conceptName}</span>
                <span className="ui-report-concept-figure tabular">
                  {concept.estimate === null
                    ? "—"
                    : `${percent(concept.estimate)} over ${concept.evidenceCount}`}
                </span>
              </li>
            ))}
          </ul>
          <Unnamed count={attentionUnnamed} />
        </section>
      )}

      {(payload.improved.length > 0 || payload.slipped.length > 0) && (
        <section className="ui-report-block">
          <h2 className="ui-report-heading">Change over the period</h2>
          <ul className="ui-report-movements">
            {payload.improved.map((movement) => (
              <li key={movement.conceptId} data-direction="up">
                <span>{movement.conceptName}</span>
                <span className="tabular">
                  {percent(movement.from)} → {percent(movement.to)}
                </span>
              </li>
            ))}
            {payload.slipped.map((movement) => (
              <li key={movement.conceptId} data-direction="down">
                <span>{movement.conceptName}</span>
                <span className="tabular">
                  {percent(movement.from)} → {percent(movement.to)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {payload.sittings.length > 0 && (
        <section className="ui-report-block">
          <h2 className="ui-report-heading">Tests taken</h2>
          <table className="ui-report-table">
            <thead>
              <tr>
                <th scope="col">Test</th>
                <th scope="col">Sat</th>
                <th scope="col">Marks</th>
              </tr>
            </thead>
            {groupBySeries(payload.sittings).map((group) => (
              <tbody key={group.seriesId ?? "loose"}>
                {/*
                  A named event gets a heading and its papers beneath it, and
                  no total: "Half-Yearly" above six rows says they belong
                  together, which is all the series ever claimed. `named` is
                  false for a report with no series at all, where this renders
                  as the plain table it has always been.
                */}
                {named && (
                  <tr className="ui-report-group">
                    <th scope="colgroup" colSpan={3}>
                      {group.seriesName ?? "Other tests"}
                    </th>
                  </tr>
                )}
                {group.sittings.map((sitting) => (
                  <tr key={sitting.assignmentId}>
                    <td>
                      {sitting.title}
                      <span className="ui-report-subject">
                        {sitting.subjectName}
                        {/* Said, rather than shown as four identical rows. */}
                        {sitting.attempts > 1 && ` · best of ${sitting.attempts} goes`}
                      </span>
                    </td>
                    <td className="tabular">{on(sitting.satAt)}</td>
                    <td className="tabular">
                      {sitting.awarded === null || sitting.total === null
                        ? "—"
                        : `${sitting.awarded} of ${sitting.total}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
          {payload.awaitingMarking > 0 && (
            <p className="ui-report-note">
              {payload.awaitingMarking === 1
                ? "One paper is still being marked and is not counted above."
                : `${payload.awaitingMarking} papers are still being marked and are not counted above.`}
            </p>
          )}
        </section>
      )}

      {payload.suggestions.length > 0 && (
        <section className="ui-report-block">
          <h2 className="ui-report-heading">What would help</h2>
          <ul className="ui-report-suggestions">
            {payload.suggestions.map((suggestion) => (
              <li key={suggestion}>{suggestion}</li>
            ))}
          </ul>
        </section>
      )}

      {letterhead && letterhead.signatories.length > 0 && (
        <section className="ui-report-signatures" aria-label="Signatures">
          {letterhead.signatories.map((role) => (
            <div key={role} className="ui-report-signature">
              <span className="ui-report-signature-line" aria-hidden="true" />
              <span className="ui-report-signature-role">{role}</span>
            </div>
          ))}
        </section>
      )}

      {letterhead?.reportFooter && (
        // ABOVE the caveat, never instead of it. A school's sentence about
        // itself is welcome on its own document; the product's sentence about
        // what the figures do not mean is not the school's to remove.
        <p className="ui-report-school-foot">{letterhead.reportFooter}</p>
      )}

      <footer className="ui-report-foot">
        {/*
          The caveat travels with the document, because the document travels.
          A sheet that leaves the building without this can be read as a
          verdict on a child rather than as a reading of what was measured.
        */}
        This report covers what has been tested in this period. It is not a
        ranking and there is no overall grade — the ideas are listed separately
        because that is what can be acted on.
        {letterhead && !letterhead.hidePoweredBy && (
          <span className="ui-report-powered">Prepared with Sahayak.</span>
        )}
      </footer>
    </article>
  );
}

function LetterheadBlock({
  letterhead,
  logoUrl,
}: {
  letterhead: ReportSheetLetterhead;
  logoUrl: string | null;
}) {
  const registration = [
    letterhead.affiliationNumber && `Affiliation No. ${letterhead.affiliationNumber}`,
    letterhead.schoolCode && `School code ${letterhead.schoolCode}`,
  ].filter(Boolean);
  const contact = [letterhead.contactPhone, letterhead.contactEmail, letterhead.website].filter(
    Boolean,
  );

  return (
    <div className="ui-report-letterhead">
      {logoUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="ui-report-letterhead-logo" src={logoUrl} alt="" />
      )}
      <div className="ui-report-letterhead-text">
        <p className="ui-report-letterhead-name">{letterhead.name}</p>
        {letterhead.tagline && (
          <p className="ui-report-letterhead-tagline">{letterhead.tagline}</p>
        )}
        {letterhead.address && <p className="ui-report-letterhead-line">{letterhead.address}</p>}
        {registration.length > 0 && (
          <p className="ui-report-letterhead-line">{registration.join(" · ")}</p>
        )}
        {contact.length > 0 && (
          <p className="ui-report-letterhead-line">{contact.join(" · ")}</p>
        )}
        {letterhead.principalName && (
          <p className="ui-report-letterhead-line">Principal: {letterhead.principalName}</p>
        )}
      </div>
    </div>
  );
}
