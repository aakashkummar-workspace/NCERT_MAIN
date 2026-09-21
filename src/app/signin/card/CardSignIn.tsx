"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Alert, Button, Field, Input } from "@/ui";
import { createTranslator, type Locale } from "@/i18n";

/**
 * The card form. Arriving from a QR code, the code is in the fragment and the
 * form submits by itself — scanning a card should be the whole of signing in.
 * The fragment is cleared from the address bar straight away, so the code is
 * not left in the history of a shared machine.
 */
export function CardSignIn({
  locale,
  sessionHours,
}: {
  locale: Locale;
  sessionHours: number;
}) {
  const t = createTranslator(locale);
  const router = useRouter();
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  // The request alone, with no state in it, so the arrival effect can call it
  // and apply the outcome in a callback — never setState in the effect body.
  async function send(value: string): Promise<string | null> {
    try {
      const response = await fetch("/api/auth/card/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: value }),
      });
      if (response.ok) return null;
      const body = await response.json().catch(() => null);
      return body?.error?.message ?? t("error.badCode");
    } catch {
      return t("error.network");
    }
  }

  function settle(problem: string | null) {
    if (problem === null) {
      router.replace("/student");
      router.refresh();
      return;
    }
    setError(problem);
    setPending(false);
  }

  async function submit(value: string) {
    setPending(true);
    setError(null);
    settle(await send(value));
  }

  useEffect(() => {
    // Once, on arrival. The code is read from the fragment and handed straight
    // to the request, so it is never put into state that would render it.
    if (started.current) return;
    started.current = true;
    const fromLink = window.location.hash.replace(/^#/, "");
    if (!fromLink) return;
    window.history.replaceState(null, "", window.location.pathname);
    void send(decodeURIComponent(fromLink)).then(settle);
    // Run once: re-running would post the same code twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit(code);
      }}
      noValidate
    >
      {error && (
        <div style={{ marginBottom: 16 }}>
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
      <Field label={t("signin.card.label")} htmlFor="card-code" hint={t("signin.card.hint")}>
        <Input
          id="card-code"
          className="ui-card-code-input"
          value={code}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={20}
          onChange={(event) => setCode(event.target.value)}
        />
      </Field>
      <div style={{ marginTop: 16 }}>
        <Button
          type="submit"
          variant="primary"
          loading={pending}
          loadingLabel={t("signin.card.checking")}
          disabled={code.trim().length === 0 && !pending}
        >
          {t("signin.code.submit")}
        </Button>
      </div>
      <p className="ui-hint" style={{ marginTop: 16 }}>
        {t("signin.card.sharedDevice", { count: sessionHours })}
      </p>
    </form>
  );
}
