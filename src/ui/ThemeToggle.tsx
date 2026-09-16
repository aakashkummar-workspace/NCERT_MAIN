"use client";

import { useSyncExternalStore } from "react";

type Choice = "system" | "light" | "dark";

const KEY = "sahayak-theme";
const EVENT = "sahayak-theme-change";

/**
 * Theme toggle.
 *
 * Three states, not two: "system" stamps nothing on <html>, so the page follows
 * prefers-color-scheme; an explicit choice stamps data-theme and wins in both
 * directions. The CSS in globals.css is written for exactly these three.
 *
 * localStorage is an external store, so it is read with useSyncExternalStore
 * rather than copied into state inside an effect. That keeps the server render
 * and the first client render agreed on "system" — the same value the inline
 * script in the document head has already applied — instead of flashing one
 * theme and then correcting it.
 */
export function ThemeToggle() {
  const choice = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const next: Record<Choice, Choice> = {
    system: "light",
    light: "dark",
    dark: "system",
  };
  const label: Record<Choice, string> = {
    system: "Theme: follows your system. Switch to light",
    light: "Theme: light. Switch to dark",
    dark: "Theme: dark. Switch to follow your system",
  };
  const glyph: Record<Choice, string> = { system: "◐", light: "☀", dark: "☾" };

  function apply(value: Choice) {
    const root = document.documentElement;
    if (value === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", value);
    try {
      localStorage.setItem(KEY, value);
    } catch {
      // A private window, or site data blocked. The theme still applies for
      // this visit; only remembering it fails, which is not an error worth
      // showing anyone.
    }
    window.dispatchEvent(new Event(EVENT));
  }

  return (
    <button
      type="button"
      className="ui-button"
      data-variant="ghost"
      data-size="sm"
      onClick={() => apply(next[choice])}
      aria-label={label[choice]}
      title={label[choice]}
    >
      <span aria-hidden="true">{glyph[choice]}</span>
    </button>
  );
}

function subscribe(onChange: () => void) {
  // `storage` covers another tab; the custom event covers this one.
  window.addEventListener("storage", onChange);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(EVENT, onChange);
  };
}

function getSnapshot(): Choice {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function getServerSnapshot(): Choice {
  return "system";
}
