"use client";

import { useState } from "react";
import { Alert, Button, Card } from "@/ui";

type Insight = {
  summary: string;
  nextStep: string | null;
  strength: string | null;
};

/**
 * The narrative, on request.
 *
 * Behind a button rather than generated on page load, and that is a cost
 * decision made visible: a page that wrote a paragraph every time a teacher
 * refreshed would bill them for refreshing. It also means the teacher has
 * looked at the numbers first, which is the right order — the note is a second
 * opinion on what they can already see, not a replacement for seeing it.
 */
export function InsightPanel({
  classId,
  included = true,
}: {
  classId: string;
  /** Whether the plan includes a written summary. Checked on the server too. */
  included?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [insight, setInsight] = useState<Insight | null>(null);

  async function ask() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/classes/${classId}/insight/`, {
        method: "POST",
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body?.error?.message ?? "We could not write a summary just now.");
        setPending(false);
        return;
      }
      setInsight(body.insight);
      setPending(false);
    } catch {
      setError("We could not reach the server. Nothing was lost.");
      setPending(false);
    }
  }

  return (
    <Card
      title="What this says"
      description="A short read of the figures below — what to do first, and why."
    >
      {error && <Alert tone="danger">{error}</Alert>}

      {insight ? (
        <div className="ui-insight">
          <p className="ui-insight-summary">{insight.summary}</p>
          {insight.nextStep && (
            <p className="ui-insight-line" data-tone="next">
              <span className="ui-insight-label">Start here</span>
              {insight.nextStep}
            </p>
          )}
          {insight.strength && (
            <p className="ui-insight-line" data-tone="good">
              <span className="ui-insight-label">Going well</span>
              {insight.strength}
            </p>
          )}
          <p className="ui-hint">
            {/*
              Said plainly. The note is drawn from the same figures on this
              page, and a teacher who disagrees with it should trust their own
              reading over it.
            */}
            Written from the figures below, by a model. It can be wrong — the
            numbers are the record, not this.
          </p>
        </div>
      ) : !included ? (
        // Said, rather than a button that spends a round trip to be refused.
        <p className="ui-hint">
          A written summary of the class is not part of your plan. Every figure
          below is still here.
        </p>
      ) : (
        <Button
          variant="secondary"
          loading={pending}
          loadingLabel="Reading the figures…"
          onClick={() => void ask()}
        >
          ✦ Summarise this class
        </Button>
      )}
    </Card>
  );
}
