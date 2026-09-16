"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Field, Input } from "@/ui";

/**
 * Sign in, or create a password — whichever this address needs.
 *
 * The email is fixed to the address invited rather than typed: a forwarded link
 * must not add whoever it reached, and a field that looks editable and then
 * refuses every other value is a trap. Somebody with an account can still
 * switch to "create" if the preview guessed wrong; the server decides either
 * way.
 */
export function JoinForm({
  token,
  email,
  accountExists,
}: {
  token: string;
  email: string;
  accountExists: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "create">(
    accountExists ? "signin" : "create",
  );
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      // Trailing slash: without it Next 308s the POST and the body vanishes.
      const response = await fetch("/api/institute/join/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "signin"
            ? { mode, token, email, password }
            : { mode, token, email, password, fullName },
        ),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        setError(json?.error?.message ?? "Something went wrong. Nothing was saved — try again.");
        setPending(false);
        return;
      }
      router.push("/teacher");
      router.refresh();
    } catch {
      setError("We could not reach the server. Check your connection and try again.");
      setPending(false);
    }
  }

  return (
    <form className="ui-auth-form" onSubmit={onSubmit} noValidate>
      {error && <Alert tone="danger">{error}</Alert>}

      <Field label="Email" htmlFor="join-email">
        <Input id="join-email" value={email} readOnly autoComplete="username" />
      </Field>

      {mode === "create" && (
        <Field label="Your name" htmlFor="join-name">
          <Input
            id="join-name"
            autoComplete="name"
            required
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
          />
        </Field>
      )}

      <Field
        label={mode === "signin" ? "Password" : "Choose a password"}
        htmlFor="join-password"
        hint={mode === "create" ? "At least 10 characters. Length beats punctuation." : undefined}
      >
        <Input
          id="join-password"
          type="password"
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>

      <Button
        type="submit"
        variant="primary"
        fullWidth
        loading={pending}
        loadingLabel="Joining…"
        disabled={password.length === 0 || (mode === "create" && fullName.trim().length < 2)}
      >
        {mode === "signin" ? "Sign in and join" : "Create account and join"}
      </Button>

      <button
        type="button"
        className="ui-link-button"
        onClick={() => {
          setMode(mode === "signin" ? "create" : "signin");
          setError(null);
        }}
      >
        {mode === "signin"
          ? "I do not have a Sahayak account yet"
          : "I already have a Sahayak account"}
      </button>
    </form>
  );
}
