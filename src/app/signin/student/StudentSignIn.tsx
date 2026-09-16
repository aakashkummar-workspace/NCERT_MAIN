"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Field, Input } from "@/ui";
import { createTranslator, type Locale } from "@/i18n";

/**
 * Two steps in one component, because they are one task.
 *
 * The phone number stays on screen in step two with a "change" link beside it —
 * a mistyped digit is the most likely reason a code never arrives, and making
 * the student start over to fix one character is the kind of small cruelty
 * that loses a login.
 *
 * ---------------------------------------------------------------------------
 * The locale arrives as a prop, and it has to
 * ---------------------------------------------------------------------------
 * This is a client component. It cannot read a request header and it cannot
 * open a session, so the locale is resolved once on the server in `page.tsx`
 * and handed down. That is also what keeps the two halves of one screen from
 * disagreeing: a client that re-derived the locale from `navigator.language`
 * would render the heading in Hindi and the button in English on any phone
 * whose browser setting differs from the request header, and the mismatch
 * would only appear after hydration.
 */
export function StudentSignIn({
  locale,
  codeValidMinutes,
}: {
  locale: Locale;
  /** How long the issued code lives, from `CODE_TTL_MS`. */
  codeValidMinutes: number;
}) {
  const t = createTranslator(locale);
  const router = useRouter();
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A problem with ONE field, shown beside it and marked invalid on it. The
  // form used to put "Check the highlighted fields." at the top and highlight
  // nothing, which sends a student hunting for a mark that is not there.
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [devRegistered, setDevRegistered] = useState(true);
  const [delivered, setDelivered] = useState(true);

  async function requestCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setFieldError(null);

    try {
      const response = await fetch("/api/auth/otp/request/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const body = await response.json();

      if (!response.ok) {
        // The API's own message wins when there is one — it is the specific
        // sentence ("that is not a mobile number we can send a code to") and
        // the generic fallback is not. It is also still English: API error copy
        // crosses the network with no locale on it and is a separate seam from
        // this one. A Hindi student who types a bad number therefore reads one
        // English line in a Hindi form, which is the honest current state.
        const onField = body?.error?.details?.fields?.phone;
        if (typeof onField === "string") setFieldError(onField);
        else setError(body?.error?.message ?? t("error.sendCode"));
        setPending(false);
        return;
      }

      // Present outside production only, so a developer can sign in without an
      // SMS gateway. In production this is undefined and nothing renders.
      setDevCode(body?.devCode ?? null);
      setDevRegistered(body?.devRegistered !== false);
      // The code was issued either way — its clock is already running — but
      // whether anything reached a handset is a separate fact, and the screen
      // must not claim the second because the first happened.
      setDelivered(body?.sent === true);
      setStep("code");
      setPending(false);
    } catch {
      setError(t("error.network"));
      setPending(false);
    }
  }

  async function verifyCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setFieldError(null);

    const data = new FormData(event.currentTarget);

    try {
      const response = await fetch("/api/auth/otp/verify/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, code: String(data.get("code") ?? "") }),
      });
      const body = await response.json();

      if (!response.ok) {
        const onField = body?.error?.details?.fields?.code;
        if (typeof onField === "string") setFieldError(onField);
        else setError(body?.error?.message ?? t("error.badCode"));
        setPending(false);
        return;
      }

      router.push("/student");
      router.refresh();
    } catch {
      setError(t("error.network"));
      setPending(false);
    }
  }

  if (step === "phone") {
    return (
      <form className="ui-auth-form" onSubmit={requestCode} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}

        <Field
          label={t("signin.phone.label")}
          htmlFor="phone"
          error={fieldError ?? undefined}
        >
          <Input
            id="phone"
            name="phone"
            type="tel"
            inputMode="numeric"
            autoComplete="tel"
            placeholder={t("signin.phone.placeholder")}
            value={phone}
            invalid={fieldError !== null}
            aria-describedby={fieldError ? "phone-error" : undefined}
            onChange={(event) => setPhone(event.target.value)}
            required
            autoFocus
          />
        </Field>

        <Button
          type="submit"
          variant="primary"
          size="lg"
          fullWidth
          loading={pending}
          loadingLabel={t("signin.phone.submitting")}
        >
          {t("signin.phone.submit")}
        </Button>
      </form>
    );
  }

  return (
    <form className="ui-auth-form" onSubmit={verifyCode} noValidate>
      {error && <Alert tone="danger">{error}</Alert>}

      {devCode && (
        // One interpolated sentence rather than prefix + <strong>{code}</strong>
        // + suffix. The bold was worth less than the word order: English puts
        // the code before "is" and Hindi puts it before "है" at the end of the
        // clause, so splitting the sentence around the value would hard-code
        // English grammar into the markup and no translator could fix it.
        <Alert tone="warning">
          {devRegistered
            ? t("signin.dev.notice", { code: devCode })
            : t("signin.dev.unregistered")}
        </Alert>
      )}

      {!delivered && devCode === null && (
        // Said plainly. A student staring at a phone that is never going to
        // buzz, being told the code is on its way, will wait — and then decide
        // the product is broken rather than that the message failed. Naming it
        // is the difference between a person who asks for help and one who
        // gives up.
        <Alert tone="warning" title={t("signin.undelivered.title")}>
          {t("signin.undelivered.body")}
        </Alert>
      )}

      <p className="ui-otp-sent">
        {/* The number and the "change" control follow this sentence, so the
            sentence has to end where they begin. English ends on a preposition
            ("Code sent to"), Hindi ends on a colon with the number already
            named ("इस नंबर पर कोड भेजा गया:"). Two sentences in the catalog,
            not one sentence with a hole in it. */}
        {delivered ? t("signin.code.sentTo") : t("signin.code.createdFor")}{" "}
        <strong>{phone}</strong>{" "}
        <button
          type="button"
          className="ui-link-button"
          onClick={() => {
            setStep("phone");
            setError(null);
            setFieldError(null);
            setDevCode(null);
          }}
        >
          {t("signin.code.change")}
        </button>
      </p>

      <Field
        label={t("signin.code.label")}
        htmlFor="code"
        // Pluralised through Intl.PluralRules, not `=== 1`. English picks its
        // singular at exactly one; Hindi picks the same form at zero AND one.
        hint={t("signin.code.validFor", { count: codeValidMinutes })}
        error={fieldError ?? undefined}
      >
        <Input
          invalid={fieldError !== null}
          aria-describedby={fieldError ? "code-error" : "code-hint"}
          id="code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          className="ui-otp-input tabular"
          required
          autoFocus
        />
      </Field>

      <Button
        type="submit"
        variant="primary"
        size="lg"
        fullWidth
        loading={pending}
        loadingLabel={t("signin.code.submitting")}
      >
        {t("signin.code.submit")}
      </Button>
    </form>
  );
}
