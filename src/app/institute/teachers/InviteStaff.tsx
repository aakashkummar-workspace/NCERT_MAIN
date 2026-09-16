"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Invite a colleague.
 *
 * The token comes back once and is shown once, because SMS and email delivery
 * arrive with the provider work. Until then an owner copies a link — which is
 * honest about what the product can do today, and better than a button that
 * silently sends nothing.
 */
export function InviteStaff({ canMakeOwner }: { canMakeOwner: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("TEACHER");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  async function invite() {
    setPending(true);
    setError(null);
    setLink(null);
    try {
      const response = await fetch("/api/institute/staff/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        setError(json?.error?.message ?? "Something went wrong. Try again.");
        return;
      }
      setLink(`${window.location.origin}/join/${json.token}`);
      setEmail("");
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="ui-invite">
      <div className="ui-invite-form">
        <label className="ui-field">
          <span>Email address</span>
          <input
            type="email"
            autoComplete="off"
            className="ui-input"
            value={email}
            placeholder="colleague@example.com"
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>

        <label className="ui-field">
          <span>Role</span>
          <select
            className="ui-select"
            value={role}
            onChange={(event) => setRole(event.target.value)}
          >
            <option value="TEACHER">Teacher</option>
            <option value="ADMIN">Admin</option>
            {/*
              Only an owner may create another owner. An admin who could
              promote to owner could promote themselves, which makes the
              distinction between the two roles decorative.
            */}
            {canMakeOwner && <option value="OWNER">Owner</option>}
          </select>
        </label>

        <button
          type="button"
          className="ui-button"
          data-variant="primary"
          disabled={!email.includes("@") || pending}
          onClick={() => void invite()}
        >
          <span>{pending ? "Inviting…" : "Invite"}</span>
        </button>
      </div>

      {error && <p className="ui-invite-error">{error}</p>}

      {link && (
        <div className="ui-invite-link">
          <p>
            Send them this link. It works once, expires in two weeks, and is not
            shown again.
          </p>
          <code>{link}</code>
        </div>
      )}
    </div>
  );
}
