"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CheckIcon,
  EmptyState,
  FileTextIcon,
  PlusIcon,
  UploadCloudIcon,
  UserPlusIcon,
} from "@/ui";

type Outcome =
  | { line: number; fullName: string; status: "added"; userId: string; warning?: string }
  | { line: number; fullName: string; status: "skipped"; reason: string };

type Preview = {
  overPlanLimit: number;
  studentLimit: number | null;
  detected: { delimiter: string; hadHeader: boolean; columns: string[] };
  problems: { line: number; raw: string; message: string }[];
  duplicateNames: string[];
  outcomes: Outcome[];
  willAdd: number;
  willSkip: number;
};

type Mode = "paste" | "upload" | "manual";

/**
 * Roster Studio: Adding students to a class.
 *
 * Supports Smart Paste, Drag & Drop CSV / Text upload, and Quick Manual Entry.
 * Nothing is committed until the teacher reviews the live preview.
 */
export function AddStudents({
  classId,
  variant,
}: {
  classId: string;
  variant: "empty" | "collapsed";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(variant === "empty");
  const [mode, setMode] = useState<Mode>("paste");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Quick manual input fields
  const [manualName, setManualName] = useState("");
  const [manualPhone, setManualPhone] = useState("");
  const [manualRoll, setManualRoll] = useState("");

  const lineCount = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean).length;

  async function onPreview() {
    if (text.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/roster/preview/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classId, text }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body?.error?.message ?? "We could not read that roster list.");
      } else {
        setPreview(body);
      }
    } catch {
      setError("We could not reach the server. Nothing was added.");
    }
    setBusy(false);
  }

  async function onCommit() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/classes/${classId}/students/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(
          body?.error?.message ??
            "We could not add those students. Nothing was saved.",
        );
        setBusy(false);
        return;
      }
      setText("");
      setPreview(null);
      setOpen(false);
      router.refresh();
    } catch {
      setError("We could not reach the server. Nothing was added.");
    }
    setBusy(false);
  }

  async function handleFile(file: File) {
    try {
      const content = await file.text();
      setText(content);
      setPreview(null);
      setMode("paste"); // Switch back to paste view to show the loaded content
    } catch {
      setError("Could not read this file. Please ensure it is a valid CSV or TXT file.");
    }
  }

  function onFileInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    handleFile(file);
    event.target.value = "";
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      handleFile(file);
    }
  }

  // The sample carries NO mobile numbers. Phone uniqueness is global, so a
  // real-looking number here is claimed by whichever teacher presses the button
  // first and refused for everybody after — and it would put a stranger's
  // number on a roster if it happened to be real. The names say "Sample" so a
  // teacher who commits it by accident can see what to remove.
  function loadSampleRoster() {
    const sample = `Sample Student One, 101\nSample Student Two, 102\nSample Student Three, 103`;
    setText(sample);
    setPreview(null);
  }

  function downloadSampleCsv() {
    const csvContent =
      "data:text/csv;charset=utf-8," +
      encodeURIComponent(
        "Full Name,Mobile Number,Roll Number,APAAR ID\nSample Student One,,101,\nSample Student Two,,102,\nSample Student Three,,103,",
      );
    const link = document.createElement("a");
    link.setAttribute("href", csvContent);
    link.setAttribute("download", "sahayak_sample_roster.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function addManualRow() {
    if (!manualName.trim()) return;
    const parts = [manualName.trim()];
    if (manualPhone.trim()) parts.push(manualPhone.trim());
    if (manualRoll.trim()) parts.push(manualRoll.trim());
    const row = parts.join(", ");
    setText((prev) => (prev.trim().length > 0 ? `${prev.trim()}\n${row}` : row));
    setManualName("");
    setManualPhone("");
    setManualRoll("");
    setPreview(null);
  }

  if (!open) {
    return (
      <div>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          <PlusIcon size={16} />
          <span>Add more students</span>
        </Button>
      </div>
    );
  }

  return (
    <Card
      title={variant === "empty" ? "Enrol your students" : "Add more students"}
      description="Add your class roster via Smart Paste, CSV spreadsheet, or manual quick entry. Nothing is saved until you review the live preview."
    >
      {error && (
        <div style={{ marginBottom: 14 }}>
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      {/* Mode Switcher Tabs */}
      <div className="ui-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "paste"}
          className="ui-tab-btn"
          data-active={mode === "paste"}
          onClick={() => setMode("paste")}
        >
          <FileTextIcon size={15} />
          <span>Smart Paste</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "upload"}
          className="ui-tab-btn"
          data-active={mode === "upload"}
          onClick={() => setMode("upload")}
        >
          <UploadCloudIcon size={15} />
          <span>Upload CSV / Excel</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "manual"}
          className="ui-tab-btn"
          data-active={mode === "manual"}
          onClick={() => setMode("manual")}
        >
          <UserPlusIcon size={15} />
          <span>Quick Add</span>
        </button>
      </div>

      {/* Mode 1: Smart Paste */}
      {mode === "paste" && (
        <div>
          <div className="ui-helper-chips">
            <span style={{ fontSize: 11.5, color: "var(--text-secondary)", fontWeight: 500 }}>
              Accepted formats:
            </span>
            <span className="ui-helper-chip">Name only</span>
            <span className="ui-helper-chip">Name, Mobile</span>
            <span className="ui-helper-chip">Name, Mobile, Roll</span>
            {text.trim().length === 0 && (
              <button
                type="button"
                className="ui-link-button"
                onClick={loadSampleRoster}
                style={{
                  marginLeft: "auto",
                  background: "none",
                  border: "none",
                  color: "var(--accent)",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                + Load sample names (no phone numbers)
              </button>
            )}
          </div>

          <label className="ui-label" htmlFor="roster">
            Paste your list, or upload a CSV
          </label>
          <div style={{ position: "relative" }}>
            <textarea
              id="roster"
              className="ui-textarea"
              rows={7}
              value={text}
              placeholder="Paste student names here, one per line (e.g. Priya Sharma, 9876543210)..."
              onChange={(event) => {
                setText(event.target.value);
                setPreview(null);
              }}
              aria-describedby="roster-hint"
              style={{ width: "100%", resize: "vertical" }}
            />
          </div>

          <div className="ui-textarea-footer">
            <span id="roster-hint">
              {text.trim().length === 0
                ? "Tip: paste straight from Excel or WhatsApp — one student per line, with their mobile number after the name."
                : "One student per line. Name is required; phone and roll number are optional."}
            </span>
            <span className="ui-line-count-badge">
              {lineCount} {lineCount === 1 ? "entry" : "entries"}
            </span>
          </div>

          <div className="ui-row" style={{ marginTop: 14, gap: 10, flexWrap: "wrap" }}>
            <Button
              variant="primary"
              onClick={onPreview}
              disabled={text.trim().length === 0}
              loading={busy && !preview}
              loadingLabel="Checking list…"
            >
              <CheckIcon size={15} />
              <span>
                {text.trim().length === 0
                  ? "Verify & Preview List"
                  : `Verify & Preview (${lineCount} ${lineCount === 1 ? "student" : "students"})`}
              </span>
            </Button>
            {text.trim().length > 0 && (
              <Button
                variant="ghost"
                onClick={() => {
                  setText("");
                  setPreview(null);
                }}
              >
                Clear
              </Button>
            )}
            {variant === "collapsed" && (
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Mode 2: Upload CSV / Excel */}
      {mode === "upload" && (
        <div>
          <div
            className="ui-dropzone"
            data-dragover={isDragging}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInput.current?.click()}
          >
            <div className="ui-dropzone-icon">
              <UploadCloudIcon size={22} />
            </div>
            <div className="ui-dropzone-title">
              Drop your CSV file here, or browse files
            </div>
            <div className="ui-dropzone-desc">
              Supports .csv or .txt exports from Excel, Google Sheets, or school attendance registers.
            </div>
            <div style={{ marginTop: 14 }}>
              <Button variant="secondary" size="sm">
                Choose CSV File
              </Button>
            </div>
          </div>

          <input
            ref={fileInput}
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            onChange={onFileInputChange}
            hidden
          />

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: 12,
              fontSize: 12.5,
              color: "var(--text-tertiary)",
            }}
          >
            <span>Need a formatted file to get started?</span>
            <button
              type="button"
              className="ui-link-button"
              onClick={downloadSampleCsv}
              style={{
                background: "none",
                border: "none",
                color: "var(--accent)",
                fontWeight: 600,
                cursor: "pointer",
                padding: 0,
                fontSize: 12.5,
              }}
            >
              Download Sample CSV Template
            </button>
          </div>
        </div>
      )}

      {/* Mode 3: Quick Add Manual */}
      {mode === "manual" && (
        <div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
              marginBottom: 12,
            }}
          >
            <div>
              <label className="ui-label" htmlFor="manual-name">
                Full Name *
              </label>
              <input
                id="manual-name"
                className="ui-input"
                placeholder="e.g. Rahul Sharma"
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addManualRow();
                }}
              />
            </div>
            <div>
              <label className="ui-label" htmlFor="manual-phone">
                Mobile Number (Optional)
              </label>
              <input
                id="manual-phone"
                className="ui-input"
                placeholder="e.g. 9876543210"
                value={manualPhone}
                onChange={(e) => setManualPhone(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addManualRow();
                }}
              />
            </div>
            <div>
              <label className="ui-label" htmlFor="manual-roll">
                Roll Number (Optional)
              </label>
              <input
                id="manual-roll"
                className="ui-input"
                placeholder="e.g. 15"
                value={manualRoll}
                onChange={(e) => setManualRoll(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addManualRow();
                }}
              />
            </div>
          </div>

          <div className="ui-row" style={{ gap: 10 }}>
            <Button
              variant="secondary"
              onClick={addManualRow}
              disabled={!manualName.trim()}
            >
              <PlusIcon size={15} />
              <span>Add to Roster List</span>
            </Button>
            {lineCount > 0 && (
              <Button
                variant="primary"
                onClick={onPreview}
                loading={busy && !preview}
                loadingLabel="Checking…"
              >
                <span>Verify ({lineCount}) Students</span>
              </Button>
            )}
          </div>

          {text.trim().length > 0 && (
            <div
              style={{
                marginTop: 14,
                padding: "10px 12px",
                background: "var(--surface-sunken)",
                borderRadius: "var(--radius-control)",
                border: "1px solid var(--border)",
                fontSize: 12.5,
              }}
            >
              <div style={{ fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>
                Currently queued ({lineCount} students):
              </div>
              <pre
                style={{
                  margin: 0,
                  fontFamily: "var(--font-mono, monospace)",
                  fontSize: 12,
                  color: "var(--text-primary)",
                  whiteSpace: "pre-wrap",
                }}
              >
                {text}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Live Preview Verification Section */}
      {preview && (
        <div className="ui-preview">
          <div className="ui-preview-head">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Badge tone="success">
                <strong className="tabular">{preview.willAdd}</strong> to enrol
              </Badge>
              {preview.willSkip > 0 && (
                <Badge tone="warning">
                  <strong className="tabular">{preview.willSkip}</strong> skipped
                </Badge>
              )}
            </div>

            {preview.detected.hadHeader && (
              <span className="ui-hint" style={{ margin: 0 }}>
                Header detected: {preview.detected.columns.join(", ")}
              </span>
            )}
          </div>

          <ul className="ui-preview-rows">
            {preview.outcomes.slice(0, 60).map((outcome) => (
              <li key={outcome.line} data-status={outcome.status}>
                <span className="ui-preview-mark" aria-hidden="true">
                  {outcome.status === "added" ? "+" : "–"}
                </span>
                <span className="ui-preview-name">{outcome.fullName}</span>
                <span className="ui-preview-reason">
                  {outcome.status === "skipped" ? outcome.reason : (outcome.warning ?? "")}
                </span>
              </li>
            ))}
            {preview.outcomes.length > 60 && (
              <li data-status="more">
                <span />
                <span className="ui-preview-name">
                  …and {preview.outcomes.length - 60} more
                </span>
                <span />
              </li>
            )}
          </ul>

          {preview.overPlanLimit > 0 && (
            <div style={{ marginBottom: 12 }}>
              <Alert tone="warning" title="Over your plan's student limit">
                {preview.overPlanLimit} of these students would take this
                organisation past its plan limit of {preview.studentLimit} students
                and will not be added. Change plan in Settings to add them.
              </Alert>
            </div>
          )}

          {preview.problems.length > 0 && (
            <div className="ui-preview-problems">
              {preview.problems.slice(0, 10).map((problem, index) => (
                <div key={index}>
                  <strong>Line {problem.line}:</strong> {problem.message}
                </div>
              ))}
            </div>
          )}

          {preview.duplicateNames.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <Alert tone="warning" title="Duplicate student names detected">
                {preview.duplicateNames.slice(0, 5).join(", ")} — will all be
                enrolled. To distinguish them in gradebooks, consider assigning roll numbers.
              </Alert>
            </div>
          )}

          <div className="ui-row" style={{ marginTop: 14, gap: 10 }}>
            <Button
              variant="primary"
              onClick={onCommit}
              disabled={preview.willAdd === 0}
              loading={busy}
              loadingLabel="Enrolling students…"
            >
              <CheckIcon size={15} />
              <span>
                {preview.willAdd === 1
                  ? "Confirm & Enrol 1 Student"
                  : `Confirm & Enrol ${preview.willAdd} Students`}
              </span>
            </Button>
            <Button variant="ghost" onClick={() => setPreview(null)}>
              Edit Roster
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

export function RosterEmptyState({ onStart }: { onStart: () => void }) {
  return (
    <EmptyState
      icon={<UserPlusIcon size={32} />}
      title="No students in this class yet"
      body="Paste a list of names, upload a spreadsheet, or share your Class Join Code so students can enrol themselves."
      actions={
        <Button variant="primary" onClick={onStart}>
          Enrol students
        </Button>
      }
    />
  );
}
