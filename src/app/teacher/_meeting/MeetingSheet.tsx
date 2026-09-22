import type { MeetingBrief } from "@/core/reports/meeting";

const dateFormat = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });

/**
 * One child's page for a parent–teacher meeting. Printable, one per page.
 * Lines at the foot for what was agreed — the meeting's own record is written
 * by hand, with the parent, not generated.
 */
export function MeetingSheet({ brief, schoolName }: { brief: MeetingBrief; schoolName: string }) {
  return (
    <article className="ui-meeting">
      <header className="ui-meeting-head">
        <span className="ui-meeting-school">{schoolName}</span>
        <h2 className="ui-meeting-name">{brief.studentName}</h2>
        <p className="ui-meeting-meta">
          {brief.className ? `${brief.className} · ` : ""}
          {dateFormat.format(new Date(brief.periodStart))} – {dateFormat.format(new Date(brief.periodEnd))}
        </p>
      </header>

      <section>
        <h3>What to say</h3>
        <ol className="ui-meeting-points">
          {brief.talkingPoints.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ol>
      </section>

      <div className="ui-meeting-columns">
        <section>
          <h3>Going well</h3>
          {brief.goingWell.length === 0 ? (
            <p className="ui-meeting-empty">Nothing secure yet on the evidence so far.</p>
          ) : (
            <ul>
              {brief.goingWell.map((item) => (
                <li key={item.name}>{item.name}</li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <h3>To work on</h3>
          {brief.needsWork.length === 0 ? (
            <p className="ui-meeting-empty">Nothing measured as needing work.</p>
          ) : (
            <ul>
              {brief.needsWork.map((item) => (
                <li key={item.name}>
                  {item.name}
                  {item.book && <span className="ui-meeting-book"> — {item.book}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <p className="ui-meeting-coverage">
        Measured {brief.coverage.measured} of {brief.coverage.measured + brief.coverage.unmeasured} ideas ·
        secure {brief.standing.secure} · getting there {brief.standing.developing} · needs work{" "}
        {brief.standing.needsWork}
        {brief.awaitingMarking > 0 && ` · ${brief.awaitingMarking} still being marked`}
      </p>

      {brief.papers.length > 0 && (
        <section>
          <h3>Papers this period</h3>
          <table className="ui-meeting-papers">
            <tbody>
              {brief.papers.map((paper) => (
                <tr key={`${paper.title}-${paper.satAt}`}>
                  <td>{paper.title}</td>
                  <td>{dateFormat.format(new Date(paper.satAt))}</td>
                  <td className="tabular">{paper.result}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {brief.atHome.length > 0 && (
        <section>
          <h3>At home</h3>
          <ul>
            {brief.atHome.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="ui-meeting-notes">
        <h3>Agreed at the meeting</h3>
        <span className="ui-paper-rule" />
        <span className="ui-paper-rule" />
        <span className="ui-paper-rule" />
      </section>
    </article>
  );
}
