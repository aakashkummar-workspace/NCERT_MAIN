"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Read the question aloud — an exam accommodation (CBSE's "reader"), shown
 * only to a student whose teacher granted it.
 *
 * The browser's own speech synthesis: nothing is generated on a server and
 * nothing is sent anywhere. Where the browser has none, the control is ABSENT
 * rather than disabled — the voice-input rule: a dead button costs a student
 * time mid-exam deciding whether the fault is theirs.
 */
const noop = () => () => {};
const supported = () => typeof window !== "undefined" && "speechSynthesis" in window;

export function ReadAloud({ text, questionKey }: { text: string; questionKey: string }) {
  const available = useSyncExternalStore(noop, supported, () => false);
  const [speaking, setSpeaking] = useState(false);

  // Moving to another question stops the voice: reading question 4 aloud
  // over question 5 is worse than silence.
  useEffect(() => {
    return () => {
      if (supported()) window.speechSynthesis.cancel();
    };
  }, [questionKey]);

  if (!available) return null;

  function toggle() {
    const synth = window.speechSynthesis;
    if (speaking) {
      synth.cancel();
      setSpeaking(false);
      return;
    }
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-IN";
    utterance.rate = 0.9;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    synth.speak(utterance);
    setSpeaking(true);
  }

  return (
    <button
      type="button"
      className="ui-button"
      data-variant="secondary"
      data-size="sm"
      aria-pressed={speaking}
      onClick={toggle}
    >
      <span>{speaking ? "Stop reading" : "Read aloud"}</span>
    </button>
  );
}
