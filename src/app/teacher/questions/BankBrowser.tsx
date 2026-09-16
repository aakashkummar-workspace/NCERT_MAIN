"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Badge, Button, Card, Input, Select, type Tone } from "@/ui";
import { BANK_PAGE_SIZE } from "./page-size";

type Row = {
  id: string;
  subjectId?: string;
  type: string;
  difficulty: string;
  marks: number;
  status: string;
  source: string;
  subjectName: string;
  chapterTitle: string | null;
  outcomeCount: number;
  version: number;
  stem: string;
  options?: { key: string; text: string; isCorrect: boolean }[] | null;
  answerKey?:
    | { kind: "choice"; correctKeys: string[] }
    | { kind: "boolean"; correct: boolean }
    | { kind: "numeric"; value: number; tolerance: number; unit?: string }
    | { kind: "text"; accepted: string[]; caseSensitive: boolean }
    | null;
  explanation?: string | null;
};

type Summary = {
  total: number;
  draft: number;
  inReview: number;
  approved: number;
  rejected: number;
  archived: number;
};

export type Filters = {
  search: string;
  status: string;
  type: string;
  subjectId: string;
  chapterId: string;
  difficulty: string;
};

const NO_FILTERS: Filters = {
  search: "",
  status: "",
  type: "",
  subjectId: "",
  chapterId: "",
  difficulty: "",
};

/**
 * The answer, under the question. A teacher choosing questions for a paper
 * checks the key while reading the stem, so the list carries it rather than
 * sending them into each question in turn.
 */
function Answer({ row }: { row: Row }) {
  const key = row.answerKey ?? null;
  const correct = new Set(key?.kind === "choice" ? key.correctKeys : []);
  const options = row.options ?? [];
  let line: string | null = null;
  if (key?.kind === "boolean") line = key.correct ? "True" : "False";
  if (key?.kind === "numeric") {
    line = `${key.value}${key.tolerance ? ` (± ${key.tolerance})` : ""}${key.unit ? ` ${key.unit}` : ""}`;
  }
  if (key?.kind === "text") line = key.accepted.join(" / ");

  return (
    <div className="ui-qb-answer">
      {options.length > 0 && (
        <ol className="ui-qb-options">
          {options.map((option) => {
            const right = option.isCorrect || correct.has(option.key);
            return (
              <li key={option.key} data-correct={right || undefined}>
                <span className="ui-qb-option-key">{option.key}</span>
                <span>{option.text}</span>
                {right && <span className="ui-qb-correct">Correct answer</span>}
              </li>
            );
          })}
        </ol>
      )}
      {line !== null && (
        <p className="ui-qb-answer-line">
          <span className="ui-qb-answer-label">Answer</span> {line}
        </p>
      )}
      {options.length === 0 && line === null && (
        <p className="ui-qb-answer-line">
          <span className="ui-qb-answer-label">Answer</span> Marked by the teacher
          {row.type === "SA" || row.type === "LA" || row.type === "VSA" || row.type === "CASE_STUDY"
            ? " — open the question for its mark scheme."
            : "."}
        </p>
      )}
      {row.explanation && (
        <p className="ui-qb-explanation">
          <span className="ui-qb-answer-label">Explanation</span> {row.explanation}
        </p>
      )}
    </div>
  );
}

/** The query string for a set of filters — the API's names, and the page's. */
function filterParams(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.search.trim()) params.set("q", filters.search.trim());
  if (filters.status) params.set("status", filters.status);
  if (filters.type) params.set("type", filters.type);
  if (filters.subjectId) params.set("subjectId", filters.subjectId);
  if (filters.chapterId) params.set("chapterId", filters.chapterId);
  if (filters.difficulty) params.set("difficulty", filters.difficulty);
  return params;
}

const STATUS_TONE: Record<string, Tone> = {
  DRAFT: "neutral",
  IN_REVIEW: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  ARCHIVED: "neutral",
};

const TYPE_LABEL: Record<string, string> = {
  MCQ: "Multiple choice",
  MULTI_SELECT: "Multi-select",
  TRUE_FALSE: "True / false",
  NUMERIC: "Numeric",
  FILL_BLANK: "Fill the blank",
  ASSERTION_REASON: "Assertion–reason",
  VSA: "Very short answer",
  SA: "Short answer",
  LA: "Long answer",
  CASE_STUDY: "Case study",
};

const label = (value: string) =>
  value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, " ");

const SEARCH_DELAY_MS = 250;

/**
 * The bank, filtered on the SERVER and read a page at a time.
 *
 * This used to filter in the browser over the rows the page happened to load —
 * the newest 500 — which was instant for a small bank and wrong for the
 * imported one: choosing a subject searched 500 of 3,880 questions and showed
 * one. Every filter now goes to `/api/questions/`, the chips count what the
 * other filters match, and the list says how much of the result it is showing.
 *
 * Fetching starts in the change handlers, never in an effect
 * (`react-hooks/set-state-in-effect` is an error here). A response that
 * arrives after a newer request has started is dropped, so typing quickly
 * cannot leave the list showing an older query's rows.
 */
export function BankBrowser({
  initialFilters,
  initial,
  initialTotal,
  summary: initialSummary,
  subjects,
  chapters,
  locked = false,
  extraParams = {},
}: {
  /** From the URL, so Back returns to the same filtered list. */
  initialFilters: Filters;
  initial: Row[];
  initialTotal: number;
  summary: Summary;
  subjects: { id: string; label: string }[];
  chapters: { id: string; subjectId: string; label: string }[];
  /** Inside one chapter: subject and chapter are fixed by the page, not chosen here. */
  locked?: boolean;
  /** Kept in the URL alongside the filters, e.g. `all=1` for the whole-bank view. */
  extraParams?: Record<string, string>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [rows, setRows] = useState<Row[]>(initial);
  const [total, setTotal] = useState(initialTotal);
  const [summary, setSummary] = useState<Summary>(initialSummary);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const latest = useRef(0);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function load(next: Filters, offset = 0) {
    const request = ++latest.current;
    setLoading(true);
    setError(null);

    const params = filterParams(next);
    params.set("limit", String(BANK_PAGE_SIZE));
    params.set("offset", String(offset));

    try {
      const response = await fetch(`/api/questions/?${params}`);
      const body = await response.json();
      if (request !== latest.current) return;
      if (!response.ok) {
        setError(body?.error?.message ?? "We could not load the question bank.");
      } else {
        setRows((current) => (offset === 0 ? body.questions : [...current, ...body.questions]));
        setTotal(body.total);
        setSummary(body.summary);
      }
    } catch {
      if (request === latest.current) {
        setError("We could not reach the server. The list below may be out of date.");
      }
    }
    if (request === latest.current) setLoading(false);
  }

  /**
   * Written into the URL through the router, replacing rather than pushing, so
   * Back leaves the bank instead of stepping through every letter typed.
   *
   * A bare history.replaceState was tried first and is not enough: the URL
   * came back on Back, but the router restored the page it had rendered for
   * the ORIGINAL address, so the filters reset anyway. A router replace renders
   * the page for the filtered address, and that is what Back restores.
   */
  function remember(next: Filters) {
    const params = filterParams(next);
    for (const [name, value] of Object.entries(extraParams)) params.set(name, value);
    const query = params.toString();
    router.replace(`${pathname}${query ? `?${query}` : ""}`, { scroll: false });
  }

  function change(patch: Partial<Filters>) {
    const next = { ...filters, ...patch };
    // A chapter belongs to one subject; changing subject clears it.
    if ("subjectId" in patch) next.chapterId = "";
    setFilters(next);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if ("search" in patch) {
      searchTimer.current = setTimeout(() => {
        remember(next);
        void load(next);
      }, SEARCH_DELAY_MS);
    } else {
      remember(next);
      void load(next);
    }
  }

  const filtered = Boolean(
    filters.search ||
      filters.status ||
      filters.type ||
      (!locked && (filters.subjectId || filters.chapterId)) ||
      filters.difficulty,
  );
  // Clearing inside a chapter clears the refinements, never the chapter.
  const cleared: Filters = locked
    ? { ...NO_FILTERS, subjectId: filters.subjectId, chapterId: filters.chapterId }
    : NO_FILTERS;
  const subjectChapters = chapters.filter((chapter) => chapter.subjectId === filters.subjectId);

  const chips: { status: string; text: string; count: number; always?: boolean }[] = [
    { status: "", text: "All", count: summary.total, always: true },
    { status: "DRAFT", text: "Drafts", count: summary.draft, always: true },
    { status: "IN_REVIEW", text: "In review", count: summary.inReview },
    { status: "APPROVED", text: "Approved", count: summary.approved, always: true },
    { status: "REJECTED", text: "Rejected", count: summary.rejected },
    { status: "ARCHIVED", text: "Archived", count: summary.archived },
  ];

  return (
    <>
      <div className="ui-bank-summary">
        {chips
          .filter((chip) => chip.always || chip.count > 0 || filters.status === chip.status)
          .map((chip) => (
            <button
              key={chip.status || "all"}
              type="button"
              className="ui-bank-chip"
              data-active={filters.status === chip.status || undefined}
              aria-pressed={filters.status === chip.status}
              onClick={() => change({ status: chip.status })}
            >
              {chip.text} <span className="tabular">{chip.count}</span>
            </button>
          ))}
      </div>

      <div className="ui-bank-filters">
        <Input
          placeholder="Search the question text"
          aria-label="Search questions"
          type="search"
          value={filters.search}
          onChange={(event) => change({ search: event.target.value })}
        />
        {!locked && subjects.length > 0 && (
          <Select
            aria-label="Filter by subject"
            value={filters.subjectId}
            onChange={(event) => change({ subjectId: event.target.value })}
          >
            <option value="">All subjects</option>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </Select>
        )}
        {!locked && filters.subjectId && subjectChapters.length > 0 && (
          <Select
            aria-label="Filter by chapter"
            value={filters.chapterId}
            onChange={(event) => change({ chapterId: event.target.value })}
          >
            <option value="">All chapters</option>
            {subjectChapters.map((chapter) => (
              <option key={chapter.id} value={chapter.id}>
                {chapter.label}
              </option>
            ))}
          </Select>
        )}
        <Select
          aria-label="Filter by difficulty"
          value={filters.difficulty}
          onChange={(event) => change({ difficulty: event.target.value })}
        >
          <option value="">Any difficulty</option>
          <option value="EASY">Easy</option>
          <option value="MEDIUM">Medium</option>
          <option value="HARD">Hard</option>
        </Select>
        <Select
          aria-label="Filter by type"
          value={filters.type}
          onChange={(event) => change({ type: event.target.value })}
        >
          <option value="">Any type</option>
          {Object.entries(TYPE_LABEL).map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </Select>
      </div>

      <p className="ui-bank-count" role="status" aria-live="polite">
        {loading
          ? "Loading…"
          : total === 0
            ? "No questions match."
            : rows.length < total
              ? `Showing ${rows.length} of ${total} ${total === 1 ? "question" : "questions"}`
              : `${total} ${total === 1 ? "question" : "questions"}`}
      </p>

      {error && (
        <Card>
          <p style={{ margin: 0, fontSize: 14, color: "var(--danger)" }}>{error}</p>
        </Card>
      )}

      {rows.length === 0 && !loading ? (
        <Card>
          <p style={{ margin: 0, fontSize: 14, color: "var(--text-secondary)" }}>
            No question matches those filters.{" "}
            {filtered && (
              <button
                type="button"
                className="ui-linklike"
                onClick={() => {
                  if (searchTimer.current) clearTimeout(searchTimer.current);
                  setFilters(cleared);
                  remember(cleared);
                  void load(cleared);
                }}
              >
                Clear them
              </button>
            )}
          </p>
        </Card>
      ) : (
        <ul className="ui-question-list" aria-busy={loading}>
          {rows.map((row) => (
            <li key={row.id}>
              <Link href={`/teacher/questions/${row.id}`}>
                <span className="ui-question-stem">{row.stem}</span>
                <span className="ui-question-meta">
                  <Badge tone={STATUS_TONE[row.status] ?? "neutral"}>
                    {label(row.status)}
                  </Badge>
                  <span>{TYPE_LABEL[row.type] ?? row.type}</span>
                  <span>{label(row.difficulty)}</span>
                  <span className="tabular">
                    {row.marks} {row.marks === 1 ? "mark" : "marks"}
                  </span>
                  {row.version > 1 && (
                    <span className="tabular">v{row.version}</span>
                  )}
                  {row.source === "AI_GENERATED" && (
                    // A reviewer should know what they are reading. An
                    // unlabelled generated draft in a list of typed ones gets
                    // the same glance as the rest, and it is the one that
                    // needs a second look.
                    <Badge tone="ai">Generated</Badge>
                  )}
                  {row.outcomeCount === 0 && (
                    <Badge tone="warning">No outcome</Badge>
                  )}
                  {!filters.subjectId && (
                    <span className="ui-question-subject">{row.subjectName}</span>
                  )}
                  {!locked && row.chapterTitle && (
                    <span className="ui-question-chapter">{row.chapterTitle}</span>
                  )}
                </span>
              </Link>
              <Answer row={row} />
            </li>
          ))}
        </ul>
      )}

      {rows.length > 0 && rows.length < total && (
        <div className="ui-bank-more">
          <Button
            variant="secondary"
            onClick={() => void load(filters, rows.length)}
            loading={loading}
            loadingLabel="Loading…"
          >
            Show {Math.min(BANK_PAGE_SIZE, total - rows.length)} more
          </Button>
        </div>
      )}

      {!locked && subjects.length === 0 && (
        <p className="ui-hint">No subjects are available yet.</p>
      )}
    </>
  );
}
