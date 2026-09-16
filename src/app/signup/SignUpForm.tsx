"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Field, Input, Select } from "@/ui";

export type BoardChoice = { code: string; name: string; authored: boolean };

type FieldErrors = Partial<
  Record<"fullName" | "email" | "password" | "organizationName", string>
>;

export function SignUpForm({ boards }: { boards: BoardChoice[] }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setFormError(null);
    setErrors({});

    const data = new FormData(event.currentTarget);
    const payload = {
      fullName: String(data.get("fullName") ?? ""),
      email: String(data.get("email") ?? ""),
      password: String(data.get("password") ?? ""),
      organizationName: String(data.get("organizationName") ?? ""),
      organizationType: String(data.get("organizationType") ?? "SOLO_TEACHER"),
      boardCode: String(data.get("boardCode") ?? ""),
    };

    try {
      // Trailing slash matters: without it Next 308s the POST and the body
      // silently vanishes on the redirect.
      const response = await fetch("/api/auth/signup/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const body = await response.json();

      if (!response.ok) {
        if (body?.error?.details?.fields) {
          setErrors(body.error.details.fields as FieldErrors);
          setFormError("Check the highlighted fields.");
        } else {
          setFormError(
            body?.error?.message ??
              "We could not create your account just now. Nothing was saved — please try again.",
          );
        }
        setPending(false);
        return;
      }

      router.push("/teacher");
      router.refresh();
    } catch {
      setFormError(
        "We could not reach the server. Your details were not sent — check your connection and try again.",
      );
      setPending(false);
    }
  }

  return (
    <form className="ui-auth-form" onSubmit={onSubmit} noValidate>
      {formError && <Alert tone="danger">{formError}</Alert>}

      <Field label="Your name" htmlFor="fullName" error={errors.fullName}>
        <Input
          id="fullName"
          name="fullName"
          autoComplete="name"
          required
          invalid={Boolean(errors.fullName)}
          aria-describedby={errors.fullName ? "fullName-error" : undefined}
        />
      </Field>

      <Field label="Email" htmlFor="email" error={errors.email}>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          invalid={Boolean(errors.email)}
          aria-describedby={errors.email ? "email-error" : undefined}
        />
      </Field>

      <Field
        label="Password"
        htmlFor="password"
        hint="At least 10 characters. Length beats punctuation."
        error={errors.password}
      >
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          invalid={Boolean(errors.password)}
          aria-describedby={
            errors.password ? "password-error" : "password-hint"
          }
        />
      </Field>

      <Field
        label="Organisation name"
        htmlFor="organizationName"
        hint="Your centre, or just your own name if you teach alone."
        error={errors.organizationName}
      >
        <Input
          id="organizationName"
          name="organizationName"
          required
          invalid={Boolean(errors.organizationName)}
          aria-describedby={
            errors.organizationName
              ? "organizationName-error"
              : "organizationName-hint"
          }
        />
      </Field>

      {/*
        The board is chosen here and nowhere else afterwards: every curriculum
        read takes it from the organization on the session. It stays changeable
        in settings only while the account is empty — see core/organizations.
      */}
      <Field
        label="Which board do you teach?"
        htmlFor="boardCode"
        hint="Your classes, chapters and papers all come from this board's syllabus. You can change it in settings until you have created your first class."
      >
        <Select
          id="boardCode"
          name="boardCode"
          defaultValue={boards[0]?.code ?? "CBSE"}
          aria-describedby="boardCode-hint"
        >
          {boards.map((board) => (
            <option key={board.code} value={board.code} disabled={!board.authored}>
              {board.name}
              {board.authored ? "" : " — syllabus not authored yet"}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="What describes you best?" htmlFor="organizationType">
        <Select id="organizationType" name="organizationType" defaultValue="SOLO_TEACHER">
          <option value="SOLO_TEACHER">I teach on my own</option>
          <option value="TUITION_CENTRE">Tuition centre</option>
          <option value="COACHING_INSTITUTE">Coaching institute</option>
          <option value="SCHOOL">School</option>
        </Select>
      </Field>

      <Button
        type="submit"
        variant="primary"
        size="lg"
        fullWidth
        loading={pending}
        loadingLabel="Creating your account…"
      >
        Create account
      </Button>
    </form>
  );
}
