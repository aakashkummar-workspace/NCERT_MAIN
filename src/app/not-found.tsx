import Link from "next/link";

export default function NotFound() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <div style={{ maxWidth: "44ch", textAlign: "center" }}>
        <h1 className="ui-page-title">We could not find that page</h1>
        <p className="ui-page-description" style={{ margin: "10px auto 22px" }}>
          The link may be out of date, or the page may belong to a part of the
          product that is not built yet.
        </p>
        <Link href="/teacher" className="ui-button" data-variant="primary" data-size="md">
          <span>Go to your dashboard</span>
        </Link>
      </div>
    </main>
  );
}
