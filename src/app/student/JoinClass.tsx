"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Field, Input } from "@/ui";

/**
 * Join a class with a code.
 *
 * The code is read aloud in a classroom and typed on a phone, so it is
 * uppercased as you type and spaces are ignored — the alphabet already
 * excludes every pair that gets misread (no O/0, no I/1/L).
 */
export function JoinClass() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/student/join/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = await response.json();

      if (!response.ok) {
        setError(body?.error?.message ?? "We could not join that class.");
        setPending(false);
        return;
      }

      setJoined(body.className);
      setCode("");
      setPending(false);
      router.refresh();
    } catch {
      setError("We could not reach the server. Check your connection and try again.");
      setPending(false);
    }
  }

  if (!open) {
    return (
      <div className="ui-join">
        <button
          type="button"
          className="ui-link-button"
          onClick={() => setOpen(true)}
        >
          Join a class with a code
        </button>
      </div>
    );
  }

  return (
    <div className="ui-join" data-open="true">
      {joined && (
        <Alert tone="success">
          You are in <strong>{joined}</strong>. Any tests set for it will appear
          here.
        </Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}

      <form className="ui-join-form" onSubmit={submit} noValidate>
        <Field label="Class code" htmlFor="code">
          <Input
            id="code"
            name="code"
            className="ui-join-code"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            maxLength={12}
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            autoFocus
            required
          />
        </Field>
        <Button type="submit" variant="primary" loading={pending} loadingLabel="Joining…">
          Join
        </Button>
      </form>
    </div>
  );
}
