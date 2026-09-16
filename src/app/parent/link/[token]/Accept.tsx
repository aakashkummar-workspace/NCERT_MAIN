"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Accepting an invitation.
 *
 * Two steps on one screen: ask for a code, then enter it. Splitting them across
 * two pages loses the token on a back button and makes a parent who mistyped
 * their number start again from the SMS.
 *
 * The phone field is pre-filled with nothing and hinted with the last four
 * digits of the invited number. A parent who has two numbers needs to know
 * which one the teacher used; a stranger holding the link learns four digits of
 * a number they would have to already have to get any further.
 */
export function Accept({
  token,
  studentName,
  phoneHint,
}: {
  token: string;
  studentName: string;
  phoneHint: string;
}) {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [fullName, setFullName] = useState("");
  const [sent, setSent] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function requestCode() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/otp/request/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        setError(json?.error?.message ?? "Something went wrong. Try again.");
        return;
      }
      setSent(true);
      if (json?.devCode) setDevCode(json.devCode);
    } finally {
      setPending(false);
    }
  }

  async function accept() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/parent/accept/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          phone,
          code,
          fullName: fullName.trim() || undefined,
        }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        setError(json?.error?.message ?? "Something went wrong. Try again.");
        return;
      }
      router.push("/parent");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="ui-accept">
      {error && <p className="ui-accept-error">{error}</p>}

      {!sent ? (
        <>
          <label className="ui-accept-field">
            <span>Your mobile number</span>
            <input
              type="tel"
              inputMode="numeric"
              autoComplete="tel"
              className="ui-input"
              value={phone}
              // NOT the masked hint. A placeholder of "•••••• 2554" reads as a
              // value already filled in, so the disabled button underneath
              // looks broken rather than waiting. The hint below says which
              // number without pretending to be one.
              placeholder="10-digit mobile number"
              onChange={(event) => setPhone(event.target.value)}
            />
            <span className="ui-accept-hint">
              Use the number the centre has for you — it ends {phoneHint.slice(-4)}.
            </span>
          </label>

          <button
            type="button"
            className="ui-button"
            data-variant="primary"
            data-size="lg"
            data-full="true"
            disabled={phone.replace(/\D/g, "").length < 10 || pending}
            onClick={() => void requestCode()}
          >
            <span>{pending ? "Sending…" : "Send me a code"}</span>
          </button>
        </>
      ) : (
        <>
          <label className="ui-accept-field">
            <span>The six-digit code</span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              className="ui-input ui-accept-code"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
            />
          </label>

          {devCode && (
            // Development only, and the server decides — a code that reached a
            // log file in production would be a credential in a log file.
            <p className="ui-accept-hint">Development code: {devCode}</p>
          )}

          <label className="ui-accept-field">
            <span>Your name</span>
            <input
              type="text"
              autoComplete="name"
              className="ui-input"
              value={fullName}
              placeholder={`Parent of ${studentName.split(/\s+/)[0]}`}
              onChange={(event) => setFullName(event.target.value)}
            />
            <span className="ui-accept-hint">
              So the centre knows who to talk to. You can leave it blank.
            </span>
          </label>

          <button
            type="button"
            className="ui-button"
            data-variant="primary"
            data-size="lg"
            data-full="true"
            disabled={code.length < 4 || pending}
            onClick={() => void accept()}
          >
            <span>{pending ? "Checking…" : "Agree and see progress"}</span>
          </button>

          <button
            type="button"
            className="ui-button"
            data-variant="ghost"
            data-size="lg"
            data-full="true"
            disabled={pending}
            onClick={() => {
              setSent(false);
              setCode("");
              setDevCode(null);
            }}
          >
            <span>Use a different number</span>
          </button>
        </>
      )}
    </div>
  );
}
