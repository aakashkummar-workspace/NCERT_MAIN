import type { Client } from "pg";

export const FIXTURE_CHAPTER_FLOOR: number;
export function fixtureChapterNumber(): number;
export function databaseNow(db: Client): Promise<string>;
export function removeFixtureCurriculum(
  db: Client,
  since: string,
): Promise<{ chapters: number; outcomes: number; concepts: number }>;
