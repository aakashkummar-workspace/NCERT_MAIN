"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Field, Input } from "@/ui";

export function SignInForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setFormError(null);

    const data = new FormData(event.currentTarget);

    try {
      const response = await fetch("/api/auth/signin/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: String(data.get("identifier") ?? ""),
          password: String(data.get("password") ?? ""),
        }),
      });

      const body = await response.json();

      if (!response.ok) {
        setFormError(
          body?.error?.message ??
            "We could not sign you in just now. Please try again.",
        );
        setPending(false);
        return;
      }

      router.push("/teacher");
      router.refresh();
    } catch {
      setFormError(
        "We could not reach the server. Check your connection and try again.",
      );
      setPending(false);
    }
  }

  return (
    <form className="ui-auth-form" onSubmit={onSubmit} noValidate>
      {formError && <Alert tone="danger">{formError}</Alert>}

      <Field label="Email" htmlFor="identifier">
        <Input
          id="identifier"
          name="identifier"
          type="email"
          autoComplete="email"
          required
          autoFocus
        />
      </Field>

      <Field label="Password" htmlFor="password">
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </Field>

      <Button
        type="submit"
        variant="primary"
        size="lg"
        fullWidth
        loading={pending}
        loadingLabel="Signing in…"
      >
        Sign in
      </Button>
    </form>
  );
}
