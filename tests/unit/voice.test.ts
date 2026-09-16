import { describe, expect, it } from "vitest";
import {
  appendTranscript,
  resolveLang,
  speechErrorMessage,
  speechRecognitionCtor,
} from "@/ui/VoiceInput";

/**
 * The browser API itself is not tested here and cannot usefully be: there is
 * no microphone, no recogniser and no permission prompt in a node process, and
 * a mock of `SpeechRecognition` would only assert that the mock was called.
 *
 * What IS tested is every decision the component makes that does not need a
 * browser — which is all of the ones that can lose a student's work:
 *
 *   - whether the control renders at all;
 *   - what happens to text that is already written;
 *   - what a student is told when it fails;
 *   - which language is recognised.
 */

/* --------------------------------------------------- feature detection -- */

describe("speechRecognitionCtor", () => {
  it("finds the unprefixed constructor", () => {
    const ctor = function Recognition() {};
    expect(speechRecognitionCtor({ SpeechRecognition: ctor })).toBe(ctor);
  });

  it("finds the webkit-prefixed one, which is most Android students", () => {
    const ctor = function Recognition() {};
    expect(speechRecognitionCtor({ webkitSpeechRecognition: ctor })).toBe(ctor);
  });

  it("prefers the standard name when a browser has both", () => {
    const standard = function Standard() {};
    const prefixed = function Prefixed() {};
    expect(
      speechRecognitionCtor({
        SpeechRecognition: standard,
        webkitSpeechRecognition: prefixed,
      }),
    ).toBe(standard);
  });

  /**
   * The one that decides whether a dead button appears in front of somebody
   * sitting an exam. Every shape a window can be missing it in has to answer
   * null, not "probably fine".
   */
  it("answers null on a window that does not have it — Firefox", () => {
    expect(speechRecognitionCtor({})).toBeNull();
  });

  it("answers null when the property exists but is not constructible", () => {
    // A polyfill that half-loaded, or an extension that stubbed the name.
    expect(speechRecognitionCtor({ SpeechRecognition: undefined })).toBeNull();
    expect(speechRecognitionCtor({ SpeechRecognition: null })).toBeNull();
    expect(speechRecognitionCtor({ SpeechRecognition: true })).toBeNull();
    expect(speechRecognitionCtor({ SpeechRecognition: "yes" })).toBeNull();
    expect(speechRecognitionCtor({ SpeechRecognition: {} })).toBeNull();
  });

  it("answers null when there is no window at all — the server render", () => {
    expect(speechRecognitionCtor(undefined)).toBeNull();
    expect(speechRecognitionCtor(null)).toBeNull();
  });
});

/* -------------------------------------------------------------- append -- */

describe("appendTranscript", () => {
  it("appends rather than replaces — the whole reason it exists", () => {
    const written = "A triangle has three sides.";
    expect(appendTranscript(written, "Its angles add to 180 degrees")).toBe(
      "A triangle has three sides. Its angles add to 180 degrees",
    );
  });

  it("survives being called three times without losing a word", () => {
    let text = "";
    text = appendTranscript(text, "First point.");
    text = appendTranscript(text, "Second point.");
    text = appendTranscript(text, "Third point.");
    expect(text).toBe("First point. Second point. Third point.");
  });

  it("never touches what is already there", () => {
    // Not trimmed, not re-cased, not re-flowed: the student typed it.
    const written = "  ok so   the ANSWER is";
    expect(appendTranscript(written, "twelve")).toBe(
      "  ok so   the ANSWER is twelve",
    );
  });

  it("does not add a leading space to an empty answer", () => {
    expect(appendTranscript("", "The first thing I say")).toBe(
      "The first thing I say",
    );
  });

  it("keeps a trailing newline and does not put a space after it", () => {
    expect(appendTranscript("Point one.\n", "Point two.")).toBe(
      "Point one.\nPoint two.",
    );
  });

  it("does not double the space when the answer already ends in one", () => {
    expect(appendTranscript("Because ", "the sides are equal")).toBe(
      "Because the sides are equal",
    );
  });

  /**
   * A recogniser that heard nothing sends an empty final result rather than no
   * result. Appending it would mark the answer dirty, which on this path means
   * a queued autosave and a network request for nothing.
   */
  it("returns the answer untouched when nothing was heard", () => {
    expect(appendTranscript("Already written", "")).toBe("Already written");
    expect(appendTranscript("Already written", "   ")).toBe("Already written");
    expect(appendTranscript("Already written", "\n\t ")).toBe(
      "Already written",
    );
    expect(appendTranscript("", "  ")).toBe("");
  });

  it("collapses the recogniser's own padding rather than pasting it in", () => {
    expect(appendTranscript("Start.", "  two   words  ")).toBe(
      "Start. two words",
    );
  });
});

/* --------------------------------------------------------------- errors -- */

describe("speechErrorMessage", () => {
  const CODES = [
    "not-allowed",
    "service-not-allowed",
    "audio-capture",
    "no-speech",
    "network",
    "language-not-supported",
    "bad-grammar",
    "something-nobody-has-seen-yet",
  ];

  it("gives permission, microphone and silence their own lines", () => {
    const permission = speechErrorMessage("not-allowed");
    const microphone = speechErrorMessage("audio-capture");
    const silence = speechErrorMessage("no-speech");

    expect(permission).not.toBe(microphone);
    expect(microphone).not.toBe(silence);
    expect(permission).not.toBe(silence);

    expect(permission).toMatch(/microphone access/i);
    expect(microphone).toMatch(/could not find a microphone/i);
    expect(silence).toMatch(/did not hear/i);
  });

  it("says nothing when the student pressed Stop", () => {
    // Not a failure, and a red line under a control they just used correctly
    // reads as one.
    expect(speechErrorMessage("aborted")).toBeNull();
  });

  it("has a line for a code it has never seen", () => {
    const message = speechErrorMessage("something-nobody-has-seen-yet");
    expect(message).not.toBeNull();
    expect(message).toMatch(/nothing you have written is lost/i);
  });

  /**
   * The rule the AI gateway already applies to a provider's message, applied to
   * a browser's: a code goes to the console, a sentence goes to the person. If
   * a raw token ever reaches this string the student is reading machine output
   * mid-exam.
   */
  it("never shows the browser's own error token", () => {
    for (const code of CODES) {
      const message = speechErrorMessage(code);
      expect(message).not.toBeNull();
      expect(message).not.toContain(code);
      expect(message).not.toMatch(/-/); // no kebab-case tokens leaked through
    }
  });

  it("always tells the student what to do next", () => {
    for (const code of CODES) {
      // Every line ends in the same escape hatch, because there always is one:
      // the textarea never went anywhere.
      expect(speechErrorMessage(code)).toMatch(/typ|written is lost/i);
    }
  });

  it("ends every line as a sentence", () => {
    for (const code of CODES) {
      expect(speechErrorMessage(code)).toMatch(/[.!?]$/);
    }
  });
});

/* -------------------------------------------------------------- language -- */

describe("resolveLang", () => {
  it("defaults to en-IN when the document says nothing", () => {
    expect(resolveLang(null)).toBe("en-IN");
    expect(resolveLang(undefined)).toBe("en-IN");
    expect(resolveLang("")).toBe("en-IN");
    expect(resolveLang("   ")).toBe("en-IN");
  });

  /**
   * A bare "en" is widened rather than passed through. Unqualified English gets
   * a US recogniser, which mishears Indian names, place names and the way
   * numbers are spoken here — and this is a CBSE product.
   */
  it("widens a bare en to en-IN", () => {
    expect(resolveLang("en")).toBe("en-IN");
    expect(resolveLang("EN")).toBe("en-IN");
    expect(resolveLang(" en ")).toBe("en-IN");
  });

  it("follows the document when it names a real tag", () => {
    expect(resolveLang("hi-IN")).toBe("hi-IN");
    expect(resolveLang("en-GB")).toBe("en-GB");
    expect(resolveLang("bn")).toBe("bn");
    expect(resolveLang("mr-IN")).toBe("mr-IN");
  });

  it("falls back rather than handing a recogniser something malformed", () => {
    expect(resolveLang("english")).toBe("en-IN");
    expect(resolveLang("e")).toBe("en-IN");
    expect(resolveLang("en_IN")).toBe("en-IN");
    expect(resolveLang("en-")).toBe("en-IN");
    expect(resolveLang("<script>")).toBe("en-IN");
  });
});
