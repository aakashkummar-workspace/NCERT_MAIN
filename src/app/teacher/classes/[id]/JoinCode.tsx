"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, CheckIcon, CopyIcon, RefreshCwIcon, ShareIcon } from "@/ui";

export function JoinCode({
  classId,
  code,
  className,
}: {
  classId: string;
  code: string | null;
  className?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function rotate() {
    if (
      !window.confirm(
        "Generate a new class code?\n\nThe current code stops working immediately. Any student who has not yet joined will need the new one.",
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await fetch(`/api/classes/${classId}/join-code/`, { method: "POST" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused. The code is on screen either way.
    }
  }

  function shareWhatsApp() {
    if (!code) return;
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const msg = `Namaste! Join our CBSE ${className ? `class (${className})` : "class"} on Sahayak.\n\n🔑 Class Code: *${code}*\n👉 Sign in here: ${origin}/signin`;
    window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(msg)}`, "_blank");
  }

  return (
    <Card
      title="Student Access Pass"
      description="Students use this unique code to automatically enrol themselves from their mobile devices."
    >
      <div className="ui-credential-ticket">
        <div className="ui-credential-badge">
          <span className="ui-credential-dot" aria-hidden="true" />
          <span>Active Join Code</span>
        </div>

        <div
          className="ui-credential-code"
          onClick={copy}
          title="Click to copy code"
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              copy();
            }
          }}
          aria-label={`Class code ${code ?? "none"}. Click to copy.`}
        >
          {code ?? "—"}
        </div>

        <div style={{ fontSize: 11.5, color: "var(--text-tertiary)", marginBottom: 14 }}>
          {copied ? (
            <span style={{ color: "var(--success)", fontWeight: 600 }}>✓ Copied to clipboard!</span>
          ) : (
            "Click code to copy or use quick actions below"
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
          <Button
            variant="secondary"
            size="sm"
            onClick={copy}
            disabled={!code}
          >
            {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
            <span>{copied ? "Copied" : "Copy code"}</span>
          </Button>

          <Button
            variant="secondary"
            size="sm"
            onClick={shareWhatsApp}
            disabled={!code}
            title="Share with students or parents on WhatsApp"
          >
            <ShareIcon size={14} />
            <span>WhatsApp</span>
          </Button>
        </div>

        <div style={{ display: "flex", justifyContent: "center", marginTop: 4 }}>
          <button
            type="button"
            className="ui-join-regenerate"
            onClick={rotate}
            disabled={busy}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-tertiary)",
              fontSize: 11.5,
              cursor: busy ? "wait" : "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "3px 6px",
            }}
          >
            <RefreshCwIcon size={12} />
            <span>{busy ? "Generating..." : "Generate new code"}</span>
          </button>
        </div>
      </div>

      <p
        style={{
          margin: "10px 0 0",
          fontSize: 11.5,
          color: "var(--text-tertiary)",
          lineHeight: 1.35,
        }}
      >
        Tip: Share this pass in your class WhatsApp group. Students sign in with their mobile number and enter this code once to join.
      </p>
    </Card>
  );
}
