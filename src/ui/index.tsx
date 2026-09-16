import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

export { Button } from "./Button";
export type { ButtonVariant, ButtonSize } from "./Button";
export * from "./icons";

/* ------------------------------------------------------------------ Field -- */

type FieldProps = {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  optional?: boolean;
  children: ReactNode;
};

/**
 * Label is always present above the control. A placeholder is never a label —
 * it disappears exactly when the user needs it, and screen readers treat it as
 * a hint rather than a name.
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  optional,
  children,
}: FieldProps) {
  return (
    <div className="ui-field">
      <label className="ui-label" htmlFor={htmlFor}>
        {label}
        {optional && <span className="ui-label-optional">optional</span>}
      </label>
      {children}
      {hint && !error && (
        <span className="ui-hint" id={`${htmlFor}-hint`}>
          {hint}
        </span>
      )}
      {error && (
        <span className="ui-error" id={`${htmlFor}-error`} role="alert">
          <span aria-hidden="true">⚠</span>
          <span>{error}</span>
        </span>
      )}
    </div>
  );
}

export function Input({
  invalid,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      {...rest}
      aria-invalid={invalid || undefined}
      className={className ? `ui-input ${className}` : "ui-input"}
    />
  );
}

export function Select({
  invalid,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select {...rest} aria-invalid={invalid || undefined} className="ui-select">
      {children}
    </select>
  );
}

export function Textarea({
  invalid,
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      {...rest}
      aria-invalid={invalid || undefined}
      className={className ? `ui-textarea ${className}` : "ui-textarea"}
    />
  );
}

/* ------------------------------------------------------------------- Card -- */

export function Card({
  title,
  description,
  action,
  padding,
  raised,
  children,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  padding?: "none";
  raised?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="ui-card" data-padding={padding} data-raised={raised || undefined}>
      {(title || action) && (
        <header className="ui-card-header">
          <div>
            {title && <h3 className="ui-card-title">{title}</h3>}
            {description && <p className="ui-card-description">{description}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

/* --------------------------------------------------------------- StatCard -- */

/**
 * A StatCard with no evidence shows an em dash and says why — never a zero.
 * 0% and "no data yet" mean opposite things to a teacher, and only one of them
 * is a reason to change a lesson plan.
 */
export function StatCard({
  label,
  value,
  context,
  empty,
  emptyReason,
}: {
  label: string;
  value?: string | number;
  context?: string;
  empty?: boolean;
  emptyReason?: string;
}) {
  const isEmpty = empty || value === undefined || value === null;
  return (
    <div className="ui-stat">
      <span className="ui-stat-label">{label}</span>
      <span
        className="ui-stat-value"
        data-empty={isEmpty || undefined}
        title={isEmpty ? emptyReason : undefined}
      >
        {isEmpty ? "—" : value}
      </span>
      {(context || (isEmpty && emptyReason)) && (
        <span className="ui-stat-context">
          {isEmpty ? emptyReason : context}
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Badge -- */

export type Tone = "neutral" | "primary" | "success" | "warning" | "danger" | "ai";

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  return (
    <span className="ui-badge" data-tone={tone}>
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ Alert -- */

const ALERT_ICON: Record<string, string> = {
  info: "i",
  success: "✓",
  warning: "⚠",
  danger: "!",
};

/**
 * Semantic colour never travels alone — every alert ships an icon and a text
 * label. A red border is not a message.
 */
export function Alert({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "success" | "warning" | "danger";
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className="ui-alert" data-tone={tone} role={tone === "danger" ? "alert" : "status"}>
      <span className="ui-alert-icon" aria-hidden="true">
        {ALERT_ICON[tone]}
      </span>
      <div>
        {title && <div className="ui-alert-title">{title}</div>}
        {children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- EmptyState -- */

/**
 * Four required parts: an icon, what is missing, why it matters, and at least
 * one button. "No data found" is never shipped.
 */
export function EmptyState({
  icon = "▢",
  title,
  body,
  actions,
}: {
  icon?: ReactNode;
  title: string;
  body: string;
  actions?: ReactNode;
}) {
  return (
    <div className="ui-empty">
      <span className="ui-empty-icon" aria-hidden="true">
        {icon}
      </span>
      <h3 className="ui-empty-title">{title}</h3>
      <p className="ui-empty-body">{body}</p>
      {actions && <div className="ui-empty-actions">{actions}</div>}
    </div>
  );
}

/* --------------------------------------------------------------- Skeleton -- */

export function Skeleton({
  width = "100%",
  height = 16,
  radius,
}: {
  width?: string | number;
  height?: string | number;
  radius?: string;
}) {
  return (
    <span
      className="ui-skeleton"
      aria-hidden="true"
      style={{
        display: "block",
        width,
        height,
        borderRadius: radius,
      }}
    />
  );
}

/* ------------------------------------------------------------- PageHeader -- */

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: ReactNode;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="ui-page-header">
      <div>
        {eyebrow && <div className="ui-page-eyebrow">{eyebrow}</div>}
        <h1 className="ui-page-title">{title}</h1>
        {description && <p className="ui-page-description">{description}</p>}
      </div>
      {actions && <div className="ui-page-actions">{actions}</div>}
    </header>
  );
}

/* ----------------------------------------------------------------- Layout -- */

export function Stack({ children }: { children: ReactNode }) {
  return <div className="ui-stack">{children}</div>;
}

export function Row({ children }: { children: ReactNode }) {
  return <div className="ui-row">{children}</div>;
}

export function Grid({ children }: { children: ReactNode }) {
  return (
    <div className="ui-grid" data-cols="auto">
      {children}
    </div>
  );
}

export function Avatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <span className="ui-avatar" aria-hidden="true">
      {initials || "?"}
    </span>
  );
}
