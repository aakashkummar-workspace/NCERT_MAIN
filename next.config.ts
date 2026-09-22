import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Only the Docker build sets this (see Dockerfile). `standalone` copies the
  // traced runtime files into .next/standalone so the image carries no full
  // node_modules; local `npm run dev` / `npm start` are unaffected.
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" as const } : {}),
  // Route handlers honour this too: POST to /api/x/ or Next 308s and the body
  // silently vanishes on the redirect. See API_SPEC.md section 1.
  trailingSlash: true,
  // Loaded at runtime, never bundled: it ships a native Claude Code binary and
  // is a devDependency used only by the local-testing provider (src/ai/claude-code.ts).
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  /**
   * The sections were single letters until the rename (/t, /s, /p, /i, /x).
   * Links to them are in bookmarks, WhatsApp messages and printed circulars,
   * and a school cannot reissue those — so the old paths redirect rather than
   * 404. Permanent, so a browser stops asking and a crawler updates its index.
   */
  async redirects() {
    const SECTIONS = {
      t: "teacher",
      s: "student",
      p: "parent",
      i: "institute",
      x: "admin",
    };
    return Object.entries(SECTIONS).flatMap(([letter, word]) => [
      { source: `/${letter}`, destination: `/${word}`, permanent: true },
      { source: `/${letter}/:path*`, destination: `/${word}/:path*`, permanent: true },
      { source: `/api/x/:path*`, destination: "/api/admin/:path*", permanent: true },
    ]).filter((rule, index, all) => all.findIndex((r) => r.source === rule.source) === index);
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
      {
        // Never cached, so a deploy's worker reaches every installed phone on
        // its next visit rather than whenever an HTTP cache happens to expire.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
