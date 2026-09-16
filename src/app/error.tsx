"use client";

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main
      style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}
    >
      <div style={{ maxWidth: "48ch", textAlign: "center" }}>
        <h1 className="ui-page-title">Something went wrong on our side</h1>
        {/*
          Errors name what survived, because the user's real question is
          "did I lose my work?"
        */}
        <p className="ui-page-description" style={{ margin: "10px auto 22px" }}>
          Nothing you had saved was affected. Trying again usually works — if it
          does not, the problem is ours and we are already logging it.
        </p>
        <button
          type="button"
          className="ui-button"
          data-variant="primary"
          data-size="md"
          onClick={reset}
        >
          <span>Try again</span>
        </button>
      </div>
    </main>
  );
}
