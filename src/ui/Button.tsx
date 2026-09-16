import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "danger"
  | "ai";
export type ButtonSize = "sm" | "md" | "lg";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Shown in place of the label while loading — the verb in progress. */
  loadingLabel?: string;
  fullWidth?: boolean;
  children: ReactNode;
};

/**
 * The one main action per view is `primary`. Everything else is secondary or
 * ghost.
 *
 * The loading state keeps the button's width and swaps the label for a spinner
 * plus the verb in progress ("Generating…"), because a button that resizes
 * mid-click moves the next one under the user's cursor.
 */
export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  loadingLabel,
  fullWidth = false,
  disabled,
  children,
  ...rest
}: Props) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-variant={variant}
      data-size={size}
      data-full={fullWidth || undefined}
      className="ui-button"
    >
      {loading && <span className="ui-button-spinner" aria-hidden="true" />}
      <span className="ui-button-label">{loading ? (loadingLabel ?? children) : children}</span>
    </button>
  );
}
