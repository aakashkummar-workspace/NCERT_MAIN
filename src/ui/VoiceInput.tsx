"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * Voice input for written answers.
 *
 * ---------------------------------------------------------------------------
 * Why the browser's own Web Speech API, and not a speech provider
 * ---------------------------------------------------------------------------
 * A cloud speech provider — Whisper, Deepgram, Google STT — would mean
 * uploading a recording of a fifteen-year-old's voice, mid-exam, to a third
 * party this product chose on their behalf. A voice is biometric-adjacent
 * personal data and the answer being dictated is the child's own work. Nothing
 * in this codebase's PII rules permits that without a great deal more thought
 * than a Phase 3 convenience feature deserves: `src/ai/` scrubs a payload down
 * to an allow-list before it reaches a model and the Copilot goes to the length
 * of replacing names with opaque handles, so shipping raw audio would be the
 * loosest data path in the product by a wide margin.
 *
 * `SpeechRecognition` costs nothing, needs no provider account, no API key and
 * no server route: there is no route handler behind this file, and no audio
 * and no transcript ever reaches a Sahayak server except as the answer text the
 * student was already going to type.
 *
 * The honest caveat, stated rather than assumed: some browsers do the
 * recognition on-device and some (Chrome) do it on their own vendor's servers,
 * under the microphone permission the student granted their browser. That is
 * materially different from us shipping a child's voice to a provider WE
 * selected and contracted with — it is the browser's relationship with its own
 * user, the same one that already handles their passwords — but it is not
 * "nothing leaves the device" on every browser, and nobody should read this
 * comment believing it is.
 *
 * ---------------------------------------------------------------------------
 * The rules this component holds
 * ---------------------------------------------------------------------------
 *   1. **Feature detection first, and it renders NOTHING when unsupported.**
 *      Firefox has no SpeechRecognition at all, and support elsewhere varies by
 *      version and by whether the page is on HTTPS. A button that is present
 *      but dead is worse than an absent one: a student under an exam clock taps
 *      it, nothing happens, and they spend thirty seconds of their paper
 *      deciding whether it is them or us.
 *
 *   2. **Dictation APPENDS. It never replaces.** Someone who dictated three
 *      sentences, stopped, and tapped Speak again must not lose them — see
 *      `appendTranscript`, which is pure and tested.
 *
 *   3. **It goes through the caller's own onChange.** The player already
 *      queues every change to localStorage and flushes it; dictated text takes
 *      exactly that path, so autosave, the offline queue and the sequence
 *      numbers need to know nothing about voice. There is deliberately no
 *      second persistence path here.
 *
 *   4. **Nothing here can block a submission.** No control is ever disabled,
 *      the textarea stays editable throughout, and if recognition hangs the
 *      student can type and submit with the panel still saying "Listening".
 *      Unmounting aborts it.
 */

/* ------------------------------------------------------------ pure parts -- */

/**
 * The browser API, structurally. lib.dom in TypeScript 5.9 ships
 * `SpeechRecognitionResult` and friends but declares no `SpeechRecognition`
 * constructor and no event types, and `webkitSpeechRecognition` is not in any
 * lib at all. Declaring the shape we actually use is both smaller and honest
 * about how little of the API this is.
 */
export type RecognitionResultLike = {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: { readonly transcript: string } | undefined;
};

export type RecognitionEventLike = {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    [index: number]: RecognitionResultLike | undefined;
  };
};

export type RecognitionErrorEventLike = { readonly error: string };

export type RecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: RecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
};

export type RecognitionCtor = new () => RecognitionLike;

/**
 * Feature detection, given any object standing in for `window`.
 *
 * Taken as an argument rather than read from the global so it can be tested
 * against a fake window — a browser API cannot be unit-tested and does not need
 * to be, but the decision of whether to render at all very much does.
 *
 * `webkitSpeechRecognition` is checked second and is not a legacy alias to be
 * tidied away later: Chrome, Edge and every Chromium browser on Android still
 * ship only the prefixed name, which is most of this product's students.
 */
export function speechRecognitionCtor(win: unknown): RecognitionCtor | null {
  if (typeof win !== "object" || win === null) return null;
  const scope = win as Record<string, unknown>;
  const candidate = scope["SpeechRecognition"] ?? scope["webkitSpeechRecognition"];
  return typeof candidate === "function" ? (candidate as RecognitionCtor) : null;
}

/**
 * Append dictated words to what is already written.
 *
 * The whole point of the function, and the reason it is separate and tested:
 * `existing` is never trimmed, never re-cased and never re-flowed. It is the
 * student's own text and the only thing this may do to it is add to the end.
 *
 * The separator is decided from what `existing` already ends with, so a student
 * who left the cursor after a newline gets their next sentence on that new
 * line rather than an orphan space in front of it.
 */
export function appendTranscript(existing: string, incoming: string): string {
  const addition = incoming.trim().replace(/\s+/g, " ");
  // A recogniser that heard nothing sends an empty final result rather than no
  // result. Appending it would move the caret and mark the answer dirty for
  // nothing, which on this path means a queued autosave and a network request.
  if (addition === "") return existing;
  if (existing === "") return addition;
  if (/\s$/.test(existing)) return existing + addition;
  return `${existing} ${addition}`;
}

/**
 * One plain-English line per failure.
 *
 * Never the browser's own string: `error` here is a machine token like
 * "audio-capture", and the same rule the AI gateway applies to a provider's
 * message applies to a browser's — a code goes to the console, a sentence goes
 * to the person. Every line says what to do next, and every line's fallback is
 * the same one: type it instead, because the textarea never went anywhere.
 */
export function speechErrorMessage(code: string): string | null {
  switch (code) {
    // The student pressed Stop, or we aborted on unmount. Not a failure, and a
    // red line under a control they just used correctly reads as one.
    case "aborted":
      return null;
    case "not-allowed":
    case "service-not-allowed":
      return "Your browser is blocking the microphone. Allow microphone access for this site in your browser settings, then try again — or just type your answer.";
    case "audio-capture":
      return "We could not find a microphone. Check that one is connected and not in use by another app, or type your answer instead.";
    case "no-speech":
      return "We did not hear anything. Try again a little closer to the microphone, or type your answer.";
    case "network":
      return "Speech could not be recognised while the connection is down. Your answers are still saved on this device — type this one instead.";
    case "language-not-supported":
    case "bad-grammar":
      return "Your browser cannot recognise speech in this language. Type your answer instead.";
    default:
      return "Speech input stopped working. Nothing you have written is lost — carry on typing.";
  }
}

/**
 * Which language to recognise.
 *
 * Follows the document, because that is what the page is already in, and falls
 * back to en-IN. A bare "en" is deliberately widened to en-IN rather than left
 * alone: an unqualified "en" gets US English, which mishears Indian names,
 * place names and the way numbers are spoken here — and this is a CBSE product.
 *
 * NOTE: this reads `document.documentElement.lang` on purpose and imports
 * nothing from `src/i18n/**`. A locale resolver is being built in parallel; a
 * component in `src/ui` should not be the first thing that depends on it, and
 * the document's own lang attribute is what the resolver will end up setting
 * anyway.
 */
export function resolveLang(documentLang: string | null | undefined): string {
  const tag = (documentLang ?? "").trim();
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(tag)) return "en-IN";
  if (/^en$/i.test(tag)) return "en-IN";
  return tag;
}

/* -------------------------------------------------------------- component -- */

type VoiceInputProps = {
  /** The current text, exactly as the caller holds it. */
  value: string;
  /**
   * Called with the FULL next value, so the caller can hand it to the same
   * handler its own textarea's onChange uses. Nothing here knows how, where or
   * whether the text is persisted, which is the point.
   */
  onChange: (next: string) => void;
  /** Names the field in the button's accessible name: "Speak your answer". */
  what?: string;
};

/**
 * Support never changes for the life of a page, so there is nothing to
 * subscribe to. It still goes through useSyncExternalStore rather than an
 * effect: the server has no `window`, and this is how a browser-only fact is
 * read without a hydration mismatch and without setting state in an effect —
 * which is an ESLint error here. Same pattern as ThemeToggle.
 */
function subscribeToNothing(): () => void {
  return () => {};
}

function supportedSnapshot(): boolean {
  return speechRecognitionCtor(window) !== null;
}

function supportedOnServer(): boolean {
  return false;
}

export function VoiceInput({ value, onChange, what = "your answer" }: VoiceInputProps) {
  const supported = useSyncExternalStore(
    subscribeToNothing,
    supportedSnapshot,
    supportedOnServer,
  );

  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<RecognitionLike | null>(null);

  // The recognition object outlives the render that created it, so its handlers
  // would otherwise close over that render's props: a student who ticks "Mark
  // for review" mid-dictation would have it undone by a stale onChange. Kept
  // fresh in an effect rather than written during render — `react-hooks/purity`
  // is an error here, and a ref written while rendering is exactly what it is
  // for.
  const latest = useRef({ value, onChange });
  useEffect(() => {
    latest.current = { value, onChange };
  });

  // Recognition holds the microphone. A student who navigates away, or whose
  // paper is submitted by the clock, must not leave it live.
  useEffect(() => {
    return () => {
      const recognition = recognitionRef.current;
      recognitionRef.current = null;
      if (!recognition) return;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.onstart = null;
      try {
        recognition.abort();
      } catch {
        // Already finished. Nothing to release and nothing to report.
      }
    };
  }, []);

  function stop() {
    const recognition = recognitionRef.current;
    if (!recognition) {
      setListening(false);
      return;
    }
    try {
      // stop(), not abort(): stop flushes whatever has been heard so far as a
      // final result, so the last sentence is not thrown away by pressing Stop.
      recognition.stop();
    } catch {
      setListening(false);
    }
  }

  function start() {
    if (recognitionRef.current) return;

    const Recognition = speechRecognitionCtor(window);
    if (!Recognition) return;

    setError(null);
    setInterim("");

    const recognition = new Recognition();
    recognition.lang = resolveLang(document.documentElement.lang);
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    // All state here moves in a browser event handler, never in an effect
    // watching derived state — `react-hooks/set-state-in-effect` is an error in
    // this repo and this is the shape it is asking for.
    recognition.onstart = () => setListening(true);

    recognition.onresult = (event) => {
      let settled = "";
      let pending = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (!result) continue;
        const alternative = result[0];
        if (!alternative) continue;
        if (result.isFinal) settled += alternative.transcript;
        else pending += alternative.transcript;
      }

      setInterim(pending.trim());

      if (settled.trim() === "") return;
      const next = appendTranscript(latest.current.value, settled);
      // Written back optimistically so a second final result arriving before
      // React has re-rendered appends to the first rather than replacing it.
      latest.current = { ...latest.current, value: next };
      latest.current.onChange(next);
    };

    recognition.onerror = (event) => {
      setError(speechErrorMessage(event.error));
      // `onend` always follows, and it is what clears `listening`. Doing it
      // here as well would race with a recogniser that recovers.
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
      setInterim("");
    };

    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setListening(false);
      setError(speechErrorMessage("unknown"));
      return;
    }
    recognitionRef.current = recognition;
  }

  // The whole control, absent. Not hidden, not disabled — absent. See rule 1.
  if (!supported) return null;

  return (
    <div className="ui-voice">
      <div className="ui-voice-row">
        <button
          type="button"
          className="ui-button"
          data-variant={listening ? "primary" : "secondary"}
          data-size="md"
          onClick={listening ? stop : start}
        >
          {/* Never colour alone: the dot is one of three signals that agree.
              The button's own name changes, the status line below says so in
              words, and this is the glance-able one. */}
          <span
            className="ui-voice-dot"
            data-listening={listening || undefined}
            aria-hidden="true"
          />
          <span>{listening ? "Stop" : `Speak ${what}`}</span>
        </button>

        {/* 13px, so --text-secondary rather than --text-tertiary, which
            globals.css documents as 14px-and-up only. */}
        <span className="ui-voice-hint">
          Added to the end of what you have written. You can edit it afterwards.
        </span>
      </div>

      {/* One live region, not two. It always exists — an element that mounts
          when something happens is announced far less reliably than one whose
          text changes — and it carries whichever line applies, so a screen
          reader is told about the error OR the state, never both at once. */}
      <p
        className="ui-voice-status"
        role="status"
        aria-live="polite"
        data-tone={error ? "error" : listening ? "listening" : undefined}
      >
        {error ??
          (listening ? "Listening. Speak now, then press Stop." : "")}
      </p>

      {interim !== "" && (
        // Not yet committed by the recogniser, so it is shown as a preview and
        // hidden from the live region — announcing every half-formed word would
        // make a screen reader unusable while dictating.
        <p className="ui-voice-interim" aria-hidden="true">
          {interim}
        </p>
      )}
    </div>
  );
}
