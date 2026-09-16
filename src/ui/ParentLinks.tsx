"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Card, Field, Input, Select, type Tone } from "./index";

/**
 * Who can see this student's progress, for the teacher responsible for them.
 *
 * Self-contained on purpose: it reads and writes through
 * `/api/students/[id]/parents` and `/api/parent-links/[id]/revoke`, so the
 * student profile needs one line to carry it and no server read of its own.
 *
 * ---------------------------------------------------------------------------
 * What it shows, and what it deliberately does not
 * ---------------------------------------------------------------------------
 * Pending invitations appear with the number MASKED — a teacher needs to
 * recognise which number they used, and a class list on a projector does not
 * need a guardian's phone on it. Revoked links stay listed as revoked: a stamp,
 * never a delete, and "was anybody ever linked" is a question the list answers.
 *
 * The invitation link is shown once, to be sent. SMS delivery of it is not
 * wired yet, and a button that says "sent" while sending nothing is the failure
 * the sign-in flow already learned from — so the teacher is told to send it.
 */

type LinkRow = {
  id: string | null;
  invitationId: string | null;
  parentName: string;
  relationship: string;
  consentGrantedAt: string | null;
  revokedAt: string | null;
  status: "INVITED" | "ACTIVE" | "REVOKED" | "EXPIRED";
};

const STATUS: Record<LinkRow["status"], { label: string; tone: Tone }> = {
  ACTIVE: { label: "Can see progress", tone: "success" },
  INVITED: { label: "Invited, not accepted", tone: "warning" },
  EXPIRED: { label: "Invitation expired", tone: "neutral" },
  REVOKED: { label: "Access removed", tone: "neutral" },
};

const RELATIONSHIP: Record<string, string> = {
  FATHER: "Father",
  MOTHER: "Mother",
  GUARDIAN: "Guardian",
};

const date = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeZone: "Asia/Kolkata",
});

export function ParentLinks({
  studentId,
  studentName,
}: {
  studentId: string;
  studentName: string;
}) {
  const [links, setLinks] = useState<LinkRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [phone, setPhone] = useState("");
  const [relationship, setRelationship] = useState("MOTHER");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentLink, setSentLink] = useState<string | null>(null);

  const base = `/api/students/${encodeURIComponent(studentId)}/parents/`;

  const load = useCallback(() => {
    return fetch(base)
      .then(async (response) => {
        const json = await response.json().catch(() => null);
        if (!response.ok) throw new Error(json?.error?.message ?? "load failed");
        setLinks((json?.links ?? []) as LinkRow[]);
        setLoadError(null);
      })
      .catch(() => {
        setLoadError("We could not load who is linked. Refresh to try again.");
      });
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function invite() {
    setPending(true);
    setError(null);
    setSentLink(null);
    try {
      const response = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, relationship }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        setError(json?.error?.message ?? "That did not work. Nothing was sent — try again.");
        return;
      }
      setSentLink(`${window.location.origin}/parent/link/${json.token}`);
      setPhone("");
      await load();
    } catch {
      setError("We could not reach the server. Nothing was created.");
    } finally {
      setPending(false);
    }
  }

  async function act(path: string, question: string) {
    if (!window.confirm(question)) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(path, { method: "POST" });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        setError(json?.error?.message ?? "That did not work. Nothing was changed.");
        return;
      }
      await load();
    } catch {
      setError("We could not reach the server. Nothing was changed.");
    } finally {
      setPending(false);
    }
  }

  const firstName = studentName.split(/\s+/)[0] ?? studentName;
  const digits = phone.replace(/\D/g, "");

  return (
    <Card
      title="Parents"
      description={`Who can see ${firstName}'s progress and released test results. Never their answers, practice or questions to the tutor.`}
    >
      {loadError && <Alert tone="danger">{loadError}</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}

      {links === null && !loadError ? (
        <p className="ui-hint">Loading…</p>
      ) : links && links.length === 0 ? (
        <p className="ui-hint">Nobody is linked to {firstName} yet.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
          {(links ?? []).map((link) => (
            <li
              key={link.id ?? link.invitationId ?? link.parentName}
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                padding: "10px 0",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
                <span style={{ fontWeight: 500, overflowWrap: "anywhere" }}>
                  {link.parentName}
                  <span className="ui-hint">
                    {" · "}
                    {RELATIONSHIP[link.relationship] ?? "Guardian"}
                  </span>
                </span>
                <span className="ui-hint">
                  {link.status === "REVOKED" && link.revokedAt
                    ? `Access removed ${date.format(new Date(link.revokedAt))}`
                    : link.consentGrantedAt
                      ? `Consented ${date.format(new Date(link.consentGrantedAt))}`
                      : "Nothing is visible to them until they accept."}
                </span>
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Badge tone={STATUS[link.status].tone}>{STATUS[link.status].label}</Badge>
                {link.status === "ACTIVE" && link.id && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      void act(
                        `/api/parent-links/${link.id}/revoke/`,
                        `Remove ${link.parentName}'s access to ${firstName}'s progress?\n\nIt stops at once. To restore it later you will need to send a new invitation.`,
                      )
                    }
                  >
                    Remove access
                  </Button>
                )}
                {(link.status === "INVITED" || link.status === "EXPIRED") &&
                  link.invitationId && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() =>
                        void act(
                          `${base}invitations/${link.invitationId}/cancel/`,
                          "Cancel this invitation? The link stops working, even if it has already been sent.",
                        )
                      }
                    >
                      Cancel invitation
                    </Button>
                  )}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
          <div style={{ flex: "1 1 180px" }}>
            <Field label="Parent's mobile number" htmlFor={`parent-phone-${studentId}`}>
              <Input
                id={`parent-phone-${studentId}`}
                type="tel"
                inputMode="numeric"
                autoComplete="off"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
              />
            </Field>
          </div>
          <div style={{ flex: "0 1 160px" }}>
            <Field label="Relationship" htmlFor={`parent-rel-${studentId}`}>
              <Select
                id={`parent-rel-${studentId}`}
                value={relationship}
                onChange={(event) => setRelationship(event.target.value)}
              >
                <option value="MOTHER">Mother</option>
                <option value="FATHER">Father</option>
                <option value="GUARDIAN">Guardian</option>
              </Select>
            </Field>
          </div>
          <Button
            variant="primary"
            disabled={digits.length < 10 || pending}
            loading={pending}
            loadingLabel="Inviting…"
            onClick={() => void invite()}
          >
            Invite parent
          </Button>
        </div>

        {sentLink && (
          <Alert tone="success" title="Invitation created — now send it">
            <p style={{ margin: "4px 0 8px" }}>
              Send this link to that number yourself. It works once, only for that
              number, expires in a week, and is not shown again.
            </p>
            <code style={{ overflowWrap: "anywhere" }}>{sentLink}</code>
          </Alert>
        )}
      </div>
    </Card>
  );
}
