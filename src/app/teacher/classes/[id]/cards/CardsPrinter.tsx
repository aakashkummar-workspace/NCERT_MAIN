"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Badge, Button, Card } from "@/ui";
import { QrCode } from "@/ui/QrCode";

type Student = {
  userId: string;
  fullName: string;
  rollNumber: string | null;
  hasPhone: boolean;
  cardHint: string | null;
  cardIssuedAt: string | null;
  cardLastUsedAt: string | null;
};

type Issued = {
  studentUserId: string;
  fullName: string;
  rollNumber: string | null;
  code: string;
};

const dateFormat = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  timeZone: "Asia/Kolkata",
});

/**
 * Issue and print sign-in cards.
 *
 * The codes live in this component's state and nowhere else — not in storage,
 * not in the URL — because a code written anywhere it can be read back is a
 * credential left lying about. Navigating away loses them, the page says so,
 * and the remedy is printing again, which cancels these.
 */
export function CardsPrinter({
  classId,
  className,
  schoolName,
  students,
}: {
  classId: string;
  className: string;
  schoolName: string;
  students: Student[];
}) {
  const router = useRouter();
  const [issued, setIssued] = useState<Issued[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const withoutCard = students.filter((s) => !s.cardHint).length;
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  async function issue(scope: "missing" | "all", studentIds?: string[]) {
    if (
      scope === "all" &&
      !studentIds &&
      !window.confirm(
        `Print new cards for all ${students.length} students? Every card already handed out will stop working.`,
      )
    ) {
      return;
    }
    setBusy(studentIds ? studentIds[0]! : scope);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/classes/${classId}/login-cards/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, ...(studentIds ? { studentIds } : {}) }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error?.message ?? "The cards could not be made.");
      } else {
        setIssued(payload.cards as Issued[]);
        router.refresh();
      }
    } catch {
      setError("We could not reach the server. No cards were made.");
    }
    setBusy(null);
  }

  async function revoke(student: Student) {
    if (!window.confirm(`Stop ${student.fullName}'s card working? They will need a new one to sign in with a card.`)) {
      return;
    }
    setBusy(`revoke:${student.userId}`);
    setError(null);
    try {
      const response = await fetch(`/api/classes/${classId}/login-cards/revoke/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentUserId: student.userId }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.error?.message ?? "That card could not be stopped.");
      } else {
        setNotice(`${student.fullName}'s card no longer works.`);
        router.refresh();
      }
    } catch {
      setError("We could not reach the server. Nothing changed.");
    }
    setBusy(null);
  }

  if (issued) {
    return (
      <>
        <div className="ui-cards-actions">
          <Alert tone="warning" title="Print these now">
            {issued.length === 1 ? "This card is" : `These ${issued.length} cards are`} shown
            once. Only a scrambled form of each code is kept, so if you leave this page before
            printing, print again — which cancels these.
          </Alert>
          <div className="ui-row" style={{ gap: 10, marginTop: 12, flexWrap: "wrap" }}>
            <Button variant="primary" onClick={() => window.print()}>
              Print cards
            </Button>
            <Button variant="secondary" onClick={() => setIssued(null)}>
              Done
            </Button>
          </div>
        </div>

        <div className="ui-cards-sheet" aria-label="Sign-in cards">
          {issued.map((card) => {
            const bare = card.code.replace(/-/g, "");
            return (
              <article key={card.studentUserId} className="ui-signin-card">
                <header className="ui-signin-card-head">
                  <span className="ui-signin-card-school">{schoolName}</span>
                  <span className="ui-signin-card-class">{className}</span>
                </header>
                <div className="ui-signin-card-body">
                  <QrCode
                    value={`${origin}/signin/card#${bare}`}
                    size={104}
                    label={`Sign-in code for ${card.fullName}`}
                  />
                  <div className="ui-signin-card-text">
                    <strong className="ui-signin-card-name">{card.fullName}</strong>
                    {card.rollNumber && (
                      <span className="ui-signin-card-roll">Roll {card.rollNumber}</span>
                    )}
                    <span className="ui-signin-card-code">{card.code}</span>
                  </div>
                </div>
                <p className="ui-signin-card-help">
                  Scan with a phone camera, or open <strong>{origin.replace(/^https?:\/\//, "")}/signin/card</strong> and
                  type the code. Keep this card safe — it is your sign-in.
                </p>
              </article>
            );
          })}
        </div>
      </>
    );
  }

  return (
    <>
      {error && <Alert tone="danger">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <Card
        title="Print cards"
        description={
          students.length === 0
            ? "There is nobody in this class yet."
            : `${students.length - withoutCard} of ${students.length} students hold a card.`
        }
      >
        <p className="ui-hint" style={{ margin: "0 0 12px" }}>
          A card carries a QR code and the same code in letters. Printing a card
          for a student cancels the one they had, so a lost card stops working
          as soon as its replacement is printed. Card sign-ins last twelve hours,
          because cards are for shared computers.
        </p>
        <div className="ui-row" style={{ gap: 10, flexWrap: "wrap" }}>
          <Button
            variant="primary"
            disabled={withoutCard === 0 || busy !== null}
            loading={busy === "missing"}
            loadingLabel="Making cards…"
            onClick={() => issue("missing")}
          >
            {withoutCard === 0
              ? "Everyone has a card"
              : `Print cards for ${withoutCard} ${withoutCard === 1 ? "student" : "students"} without one`}
          </Button>
          <Button
            variant="secondary"
            disabled={students.length === 0 || busy !== null}
            loading={busy === "all"}
            loadingLabel="Making cards…"
            onClick={() => issue("all")}
          >
            Reprint the whole class
          </Button>
        </div>
      </Card>

      {students.length > 0 && (
        <Card title="Who has a card">
          <ul className="ui-cards-roster">
            {students.map((student) => (
              <li key={student.userId}>
                <span className="ui-cards-roster-name">
                  {student.fullName}
                  {student.rollNumber && (
                    <span className="ui-hint"> · Roll {student.rollNumber}</span>
                  )}
                </span>
                <span className="ui-cards-roster-status">
                  {student.cardHint ? (
                    <>
                      <Badge tone="success">Card …{student.cardHint}</Badge>
                      <span className="ui-hint">
                        {student.cardLastUsedAt
                          ? `last used ${dateFormat.format(new Date(student.cardLastUsedAt))}`
                          : "not used yet"}
                      </span>
                    </>
                  ) : (
                    <Badge tone={student.hasPhone ? "neutral" : "warning"}>
                      {student.hasPhone ? "No card · signs in by phone" : "No card, no mobile"}
                    </Badge>
                  )}
                </span>
                <span className="ui-cards-roster-actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    loading={busy === student.userId}
                    loadingLabel="Making…"
                    onClick={() => issue("all", [student.userId])}
                  >
                    {student.cardHint ? "Replace" : "Print one"}
                  </Button>
                  {student.cardHint && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      loading={busy === `revoke:${student.userId}`}
                      loadingLabel="Stopping…"
                      onClick={() => revoke(student)}
                    >
                      Stop card
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
