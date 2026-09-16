import type { WebhookEvent } from "@prisma/client";

/**
 * The event catalogue, and the reasoning for each one.
 *
 * ---------------------------------------------------------------------------
 * Three events, chosen rather than accumulated
 * ---------------------------------------------------------------------------
 * The temptation with webhooks is to emit everything and let the receiver
 * filter. It is the wrong default twice over: every topic is a promise about a
 * payload shape that can never be narrowed afterwards, and every topic is a
 * copy of some fact leaving the building. So the catalogue starts at the two
 * things an MIS cannot learn any other way, plus the one that only ever starts
 * here.
 *
 * Deliberately NOT emitted, and worth saying why:
 *
 *   - `attempt.submitted`. High volume — a class of thirty produces thirty
 *     within an hour — and a submitted paper is not yet a fact. Everything an
 *     office would do with it, it should do at release instead.
 *   - anything from the Mistake Bank or the tutor. A child's own wrong answers
 *     and the times they asked for help are the two things this product keeps
 *     furthest from anybody's report card. Pushing them to a school server
 *     whose retention nobody here can describe is the opposite of that
 *     promise, and no MIS has asked.
 *   - `gap.detected`. A class-level judgement this product makes and stands
 *     behind on its own screens, with the evidence beside it. Stripped of that
 *     context in somebody else's dashboard it becomes a number about a teacher.
 */

export type WebhookEventName = WebhookEvent;

/** What the receiver sees in `type` and in the `X-Sahayak-Event` header. */
const WIRE: Record<WebhookEvent, string> = {
  ASSESSMENT_PUBLISHED: "assessment.published",
  RESULTS_RELEASED: "results.released",
  STUDENT_ENROLLED: "student.enrolled",
};

/** For the console. One line, written for the person configuring it. */
const LABEL: Record<WebhookEvent, { title: string; blurb: string }> = {
  ASSESSMENT_PUBLISHED: {
    title: "A paper is published",
    blurb:
      "Sent when a teacher publishes a paper, which is the point it stops changing. Carries the title, marks and duration — no student data at all.",
  },
  RESULTS_RELEASED: {
    title: "Results are released",
    blurb:
      "Sent when a teacher releases marks to a class, never when a paper is submitted. Carries one row per student: their id and their marks.",
  },
  STUDENT_ENROLLED: {
    title: "A student joins a class",
    blurb:
      "Sent when a student is added to a class or joins with a class code. Carries the student's id and the class — no name, no phone number.",
  },
};

export const ALL_EVENTS: readonly WebhookEvent[] = [
  "ASSESSMENT_PUBLISHED",
  "RESULTS_RELEASED",
  "STUDENT_ENROLLED",
];

export function wireName(event: WebhookEvent): string {
  return WIRE[event];
}

export function describeEvent(event: WebhookEvent): {
  title: string;
  blurb: string;
} {
  return LABEL[event];
}

/** True for a value that is actually in the catalogue. */
export function isWebhookEvent(value: string): value is WebhookEvent {
  return (ALL_EVENTS as readonly string[]).includes(value);
}

/** The queue and job type the delivery runner works. */
export const WEBHOOK_QUEUE = "webhooks";
export const DELIVER_JOB = "webhook.deliver";
