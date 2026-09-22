import type { MetadataRoute } from "next";

/**
 * What makes Sahayak installable: a home-screen icon that opens without the
 * browser's address bar. `/` sends a signed-in person to their own home, so it
 * is the right start whoever installed it.
 *
 * Not branded per school: an installed app keeps the manifest it was installed
 * with, and a school that changes its colours would be left with a stale icon
 * on every phone. The school's own look still applies once it opens.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Sahayak",
    short_name: "Sahayak",
    description: "Tests, practice and progress for CBSE Class 9 and 10.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f5f7fa",
    theme_color: "#4a56d2",
    lang: "en-IN",
    categories: ["education"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
