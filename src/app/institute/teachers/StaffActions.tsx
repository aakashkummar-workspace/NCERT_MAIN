"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Change a role, or take access away.
 *
 * Removal confirms and names the person, per the cross-cutting UX rule that a
 * destructive action names its blast radius. What it does NOT claim is that
 * their work goes with them — it does not, and the confirmation says so, since
 * an owner who believes removing a teacher deletes their papers will hesitate
 * over the wrong thing.
 */
export function StaffActions({
  kind,
  id,
  role,
  name,
  isSelf,
  canMakeOwner,
}: {
  kind: "member" | "invite";
  id: string;
  role?: string;
  name?: string;
  isSelf?: boolean;
  canMakeOwner?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(path: string, method: string, body?: unknown) {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        setError(json?.error?.message ?? "Something went wrong. Try again.");
        return;
      }
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  if (kind === "invite") {
    return (
      <div className="ui-staff-actions">
        {error && <span className="ui-staff-error">{error}</span>}
        <button
          type="button"
          className="ui-button"
          data-variant="ghost"
          data-size="sm"
          disabled={pending}
          onClick={() => void send(`/api/institute/invitations/${id}/`, "DELETE")}
        >
          <span>Cancel</span>
        </button>
      </div>
    );
  }

  // Your own row carries no controls at all. Changing your own role is how
  // somebody locks themselves out, and the server refuses it anyway — showing
  // a button that always errors is worse than showing none.
  if (isSelf) {
    return <span className="ui-staff-actions ui-staff-self">You</span>;
  }

  return (
    <div className="ui-staff-actions">
      {error && <span className="ui-staff-error">{error}</span>}

      <select
        className="ui-select"
        data-size="sm"
        value={role}
        disabled={pending}
        onChange={(event) =>
          void send(`/api/institute/staff/${id}/`, "PATCH", {
            role: event.target.value,
          })
        }
      >
        <option value="TEACHER">Teacher</option>
        <option value="ADMIN">Admin</option>
        {canMakeOwner && <option value="OWNER">Owner</option>}
      </select>

      <button
        type="button"
        className="ui-button"
        data-variant="ghost"
        data-size="sm"
        disabled={pending}
        onClick={() => {
          if (
            !window.confirm(
              `Remove ${name ?? "this person"}? They lose access immediately and are signed out. Everything they wrote and marked stays where it is, still attributed to them.`,
            )
          ) {
            return;
          }
          void send(`/api/institute/staff/${id}/`, "DELETE");
        }}
      >
        <span>Remove</span>
      </button>
    </div>
  );
}
