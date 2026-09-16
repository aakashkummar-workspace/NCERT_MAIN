import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  getPlayer,
  saveAnswers,
  startAttempt,
  submitAttempt,
  type AnswerPatch,
} from "@/core/attempts";
import { releaseResults } from "@/core/results";
import {
  createEndpoint,
  deliveryLog,
  listEndpoints,
  rotateSecret,
  updateEndpoint,
} from "@/core/webhooks/endpoints";
import { runWebhookDeliveries } from "@/core/webhooks/runner";
import { verifySignature, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "@/core/webhooks/sign";
import { claim } from "@/core/jobs/queue";
import { WEBHOOK_QUEUE } from "@/core/webhooks/events";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { makeWorld, studentOf, teacherOf, type World } from "./support/world";

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * The webhook slice, against a real Postgres with RLS on.
 *
 * The properties here cannot be tested any other way: the outbox is written by
 * a database trigger inside somebody else's transaction, the claim is a single
 * `for update skip locked` statement, and the tenancy of all three tables is a
 * policy rather than a WHERE clause.
 */

type Captured = { url: string; headers: Headers; body: string };

/** A receiver. Answers whatever it is told to, and records what arrived. */
function receiver(statuses: number[] | number = 200) {
  const calls: Captured[] = [];
  const queue = Array.isArray(statuses) ? [...statuses] : null;
  const fixed = Array.isArray(statuses) ? 200 : statuses;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ""),
    });
    const status = queue ? (queue.shift() ?? 200) : fixed;
    return new Response("ok", { status });
  }) as unknown as typeof fetch;

  return { calls, fetchImpl };
}

async function endpointFor(
  world: World,
  events: string[],
  url = `https://mis.example.test/${randomUUID()}`,
) {
  const created = await createEndpoint(
    { ...teacherOf(world), role: "OWNER" },
    { url, label: "Office server", events },
  );
  if (!created.ok) throw new Error(created.message);
  return { ...created, url };
}

async function jobsFor(world: World, endpointId: string) {
  return withTenant(world.organizationId, (tx) =>
    tx.job.findMany({
      where: { payload: { path: ["endpointId"], equals: endpointId } },
      orderBy: { createdAt: "asc" },
    }),
  );
}

async function outboxFor(world: World) {
  return withTenant(world.organizationId, (tx) =>
    tx.outboxEvent.findMany({ orderBy: { createdAt: "asc" } }),
  );
}

async function sit(world: World) {
  const actor = studentOf(world);
  const started = await startAttempt(actor, world.assignmentId, randomUUID());
  if (!started.ok) throw new Error(started.message);
  const player = await getPlayer(actor, started.attemptId);
  const patches: AnswerPatch[] = [];
  for (const [index, question] of player!.questions.entries()) {
    if (question.type === "MCQ") {
      patches.push({
        assessmentQuestionId: question.assessmentQuestionId,
        response: { kind: "choice", keys: ["A"] },
        clientSeq: index + 1,
      });
    } else if (question.type === "TRUE_FALSE") {
      patches.push({
        assessmentQuestionId: question.assessmentQuestionId,
        response: { kind: "boolean", value: false },
        clientSeq: index + 1,
      });
    } else if (question.type === "SA") {
      // Written and therefore unmarked until a person reads it, which is the
      // only way to reach the "marks still owed" state below.
      patches.push({
        assessmentQuestionId: question.assessmentQuestionId,
        response: { kind: "text", value: "An answer awaiting a person." },
        clientSeq: index + 1,
      });
    }
  }
  await saveAnswers(actor, started.attemptId, patches);
  await submitAttempt(actor, started.attemptId);
  return started.attemptId;
}

// ---------------------------------------------------------------------------

describe("the outbox is written in the same transaction as the thing that happened", () => {
  it("records a published paper and every enrolment, with nobody having called an emitter", () => {
    // makeWorld() publishes a paper and adds two students. Neither
    // publishAssessment nor addStudents knows this feature exists — the rows
    // are there because a trigger put them there, inside the transaction that
    // did the work. That is the whole property: it holds for the next code
    // path too, and for a backfill script, and for one whose author never read
    // the comment.
    return makeWorld().then(async (world) => {
      const events = await outboxFor(world);
      const topics = events.map((event) => event.topic);

      expect(topics).toContain("ASSESSMENT_PUBLISHED");
      expect(topics.filter((topic) => topic === "STUDENT_ENROLLED")).toHaveLength(2);
      expect(events.every((event) => event.publishedAt === null)).toBe(true);
    });
  });

  it("records a release, and only on release", async () => {
    const world = await makeWorld();
    const before = await outboxFor(world);
    expect(before.map((event) => event.topic)).not.toContain("RESULTS_RELEASED");

    // Submitting is not releasing. The release gate is the product's own
    // decision about when a mark stops being provisional, and an integration
    // that fired here would route straight around it.
    await sit(world);
    const afterSubmit = await outboxFor(world);
    expect(afterSubmit.map((event) => event.topic)).not.toContain("RESULTS_RELEASED");

    const released = await releaseResults(teacherOf(world), world.assignmentId);
    expect(released.ok).toBe(true);

    const afterRelease = await outboxFor(world);
    expect(afterRelease.filter((event) => event.topic === "RESULTS_RELEASED")).toHaveLength(1);
  });

  it("does not write a second row when a release is pressed twice", async () => {
    const world = await makeWorld();
    await sit(world);
    await releaseResults(teacherOf(world), world.assignmentId);
    await releaseResults(teacherOf(world), world.assignmentId);

    const events = await outboxFor(world);
    expect(events.filter((event) => event.topic === "RESULTS_RELEASED")).toHaveLength(1);
  });

  it("stamps the payload from the row that changed", async () => {
    const world = await makeWorld();
    const events = await outboxFor(world);
    const published = events.find((event) => event.topic === "ASSESSMENT_PUBLISHED")!;
    const payload = published.payload as Record<string, unknown>;

    expect(payload.assessmentId).toEqual(expect.any(String));
    expect(payload.totalMarks).toBe(3);
    expect(payload.durationMinutes).toBe(45);
    expect(String(payload.publishedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("fan-out", () => {
  it("queues one job per subscribed endpoint and nothing for the others", async () => {
    const world = await makeWorld();
    const subscribed = await endpointFor(world, ["ASSESSMENT_PUBLISHED"]);
    const other = await endpointFor(world, ["RESULTS_RELEASED"]);

    const { fetchImpl } = receiver(200);
    await runWebhookDeliveries({ fetchImpl });

    const mine = await jobsFor(world, subscribed.id);
    const theirs = await jobsFor(world, other.id);

    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(0);
  });

  it("publishes an event nobody wanted, rather than reconsidering it forever", async () => {
    const world = await makeWorld();
    const { fetchImpl } = receiver(200);
    await runWebhookDeliveries({ fetchImpl });

    const events = await outboxFor(world);
    expect(events.every((event) => event.publishedAt !== null)).toBe(true);
  });

  it("queues nothing the second time it runs", async () => {
    const world = await makeWorld();
    const endpoint = await endpointFor(world, ["ASSESSMENT_PUBLISHED", "STUDENT_ENROLLED"]);

    const { fetchImpl } = receiver(200);
    await runWebhookDeliveries({ fetchImpl });
    const first = await jobsFor(world, endpoint.id);

    // Two schedulers firing at once, or a crash between the enqueue and the
    // published_at stamp. Either way the dedupe key is what stops a school
    // receiving everything twice.
    await withTenant(world.organizationId, (tx) =>
      tx.outboxEvent.updateMany({ data: { publishedAt: null } }),
    );
    await runWebhookDeliveries({ fetchImpl });
    const second = await jobsFor(world, endpoint.id);

    expect(second).toHaveLength(first.length);
  });

  it("does not back-fill an endpoint added after the event", async () => {
    const world = await makeWorld();
    const { fetchImpl } = receiver(200);
    // Fan-out runs while nobody is listening.
    await runWebhookDeliveries({ fetchImpl });

    const late = await endpointFor(world, ["ASSESSMENT_PUBLISHED"]);
    await runWebhookDeliveries({ fetchImpl });

    // A new integration quietly importing last week's marks is a surprise
    // nobody asked for.
    expect(await jobsFor(world, late.id)).toHaveLength(0);
  });
});

describe("delivery", () => {
  it("signs the exact body it sent, with the timestamp inside the signature", async () => {
    const world = await makeWorld();
    const endpoint = await endpointFor(world, ["ASSESSMENT_PUBLISHED"]);

    const { calls, fetchImpl } = receiver(200);
    await runWebhookDeliveries({ fetchImpl });

    const call = calls.find((c) => c.url === endpoint.url)!;
    expect(call).toBeTruthy();
    expect(call.body).toContain("assessment.published");

    const timestamp = Number(call.headers.get(TIMESTAMP_HEADER));
    expect(Number.isFinite(timestamp)).toBe(true);

    expect(
      verifySignature({
        secret: endpoint.secret,
        timestampSeconds: timestamp,
        body: call.body,
        header: call.headers.get(SIGNATURE_HEADER)!,
        now: timestamp,
      }),
    ).toBe(true);

    const jobs = await jobsFor(world, endpoint.id);
    expect(jobs[0]!.status).toBe("SUCCEEDED");
    expect(jobs[0]!.lastError).toBeNull();
  });

  it("carries the event id, so a receiver can tell a retry from a second event", async () => {
    const world = await makeWorld();
    const endpoint = await endpointFor(world, ["ASSESSMENT_PUBLISHED"]);

    const { calls, fetchImpl } = receiver(200);
    await runWebhookDeliveries({ fetchImpl });

    const call = calls.find((c) => c.url === endpoint.url)!;
    const body = JSON.parse(call.body) as { id: string; type: string };
    expect(call.headers.get("x-sahayak-event-id")).toBe(body.id);
    expect(call.headers.get("x-sahayak-event")).toBe("assessment.published");
    // The delivery id is the job, not the event: two deliveries of one event
    // share an event id and differ here.
    expect(call.headers.get("x-sahayak-delivery")).not.toBe(body.id);
  });

  it("retries a receiver that is down, then goes DEAD rather than disappearing", async () => {
    const world = await makeWorld();
    const endpoint = await endpointFor(world, ["ASSESSMENT_PUBLISHED"]);

    const { calls, fetchImpl } = receiver(503);

    // Five passes, each far enough in the future that the backoff has elapsed.
    let now = new Date();
    for (let pass = 0; pass < 6; pass += 1) {
      await runWebhookDeliveries({ now, fetchImpl });
      now = new Date(now.getTime() + 12 * 60 * 60 * 1000);
    }

    const jobs = await jobsFor(world, endpoint.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe("DEAD");
    expect(jobs[0]!.attempts).toBe(5);
    // The row survives, which is the half that matters: an event that was never
    // delivered is still nameable months later.
    expect(jobs[0]!.lastError).toContain("http:503");
    expect(calls.filter((call) => call.url === endpoint.url)).toHaveLength(5);
  });

  it("does not follow a redirect to somewhere nobody configured", async () => {
    const world = await makeWorld();
    const endpoint = await endpointFor(world, ["ASSESSMENT_PUBLISHED"]);

    const { fetchImpl } = receiver(302);
    await runWebhookDeliveries({ fetchImpl });

    const jobs = await jobsFor(world, endpoint.id);
    // A 3xx is reported as an unacceptable status. Following it would take a
    // signed body carrying a class's marks to a host the school never named.
    expect(jobs[0]!.status).toBe("PENDING");
    expect(jobs[0]!.lastError).toContain("http:302");
  });
});

describe("refusals", () => {
  it("does not deliver an event whose endpoint was switched off after it was queued", async () => {
    const world = await makeWorld();
    const endpoint = await endpointFor(world, ["ASSESSMENT_PUBLISHED"]);

    // Queue it, but make the delivery fail so the job is still around.
    const failing = receiver(500);
    await runWebhookDeliveries({ fetchImpl: failing.fetchImpl });
    expect(await jobsFor(world, endpoint.id)).toHaveLength(1);

    await updateEndpoint({ ...teacherOf(world), role: "OWNER" }, endpoint.id, {
      active: false,
    });

    const after = receiver(200);
    const later = new Date(Date.now() + 12 * 60 * 60 * 1000);
    await runWebhookDeliveries({ now: later, fetchImpl: after.fetchImpl });

    // Off means off from the moment it is pressed, backlog included.
    expect(after.calls.some((call) => call.url === endpoint.url)).toBe(false);

    const jobs = await jobsFor(world, endpoint.id);
    expect(jobs[0]!.status).toBe("FAILED");
    expect(jobs[0]!.lastError).toContain("inactive");
  });

  it("refuses rather than retrying when the endpoint has unsubscribed", async () => {
    const world = await makeWorld();
    const endpoint = await endpointFor(world, [
      "ASSESSMENT_PUBLISHED",
      "STUDENT_ENROLLED",
    ]);

    const failing = receiver(500);
    await runWebhookDeliveries({ fetchImpl: failing.fetchImpl });

    await updateEndpoint({ ...teacherOf(world), role: "OWNER" }, endpoint.id, {
      events: ["STUDENT_ENROLLED"],
    });

    const after = receiver(200);
    const later = new Date(Date.now() + 12 * 60 * 60 * 1000);
    await runWebhookDeliveries({ now: later, fetchImpl: after.fetchImpl });

    const jobs = await jobsFor(world, endpoint.id);
    const published = jobs.find(
      (job) => (job.payload as Record<string, unknown>).event === "assessment.published",
    )!;
    expect(published.status).toBe("FAILED");
    expect(published.lastError).toContain("inactive");
  });

  it("refuses an endpoint that is not https", async () => {
    const world = await makeWorld();
    const result = await createEndpoint(
      { ...teacherOf(world), role: "OWNER" },
      {
        url: "http://mis.example.test/hook",
        label: "Office",
        events: ["ASSESSMENT_PUBLISHED"],
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("https");
  });

  it("refuses an event that is not in the catalogue", async () => {
    const world = await makeWorld();
    const result = await createEndpoint(
      { ...teacherOf(world), role: "OWNER" },
      {
        url: "https://mis.example.test/hook",
        label: "Office",
        events: ["MISTAKE_CREATED"],
      },
    );
    expect(result.ok).toBe(false);
  });
});

describe("the payload carries no personal information about a student", () => {
  it("sends ids and marks, and neither a name nor a phone number", async () => {
    const world = await makeWorld();

    // Give the student everything an integration might be tempted to forward.
    const phone = `9${String(Date.now()).slice(-9)}`;
    const guardian = `8${String(Date.now() + 1).slice(-9)}`;
    const student = await withTenant(world.organizationId, async (tx) => {
      await tx.user.updateMany({
        where: { id: world.studentId },
        data: { phone },
      });
      await tx.studentProfile.upsert({
        where: { userId: world.studentId },
        create: {
          userId: world.studentId,
          organizationId: world.organizationId,
          rollNumber: `R${randomUUID().slice(0, 6)}`,
          guardianPhone: guardian,
        },
        update: { guardianPhone: guardian },
      });
      return tx.user.findUniqueOrThrow({
        where: { id: world.studentId },
        select: { fullName: true, phone: true },
      });
    });

    await sit(world);
    await releaseResults(teacherOf(world), world.assignmentId);
    const endpoint = await endpointFor(world, ["RESULTS_RELEASED", "STUDENT_ENROLLED"]);

    const { calls, fetchImpl } = receiver(200);
    await runWebhookDeliveries({ fetchImpl });

    const sent = calls.filter((call) => call.url === endpoint.url);
    expect(sent.length).toBeGreaterThan(0);

    for (const call of sent) {
      // The whole rule, asserted against the bytes rather than the intent.
      expect(call.body).not.toContain(student.fullName);
      expect(call.body).not.toContain(phone);
      expect(call.body).not.toContain(guardian);
      // And nothing a student typed. `sit()` answers only machine-marked
      // questions, so this is belt and braces against a future payload that
      // reaches for `answers`.
      expect(call.body).not.toContain("awaiting a person");
    }

    const released = sent.find((call) => call.body.includes("results.released"))!;
    const body = JSON.parse(released.body) as {
      data: { results: { studentUserId: string; marksAwarded: number | null }[] };
    };
    // It is still useful: the office gets an id it can match and a mark it can
    // import.
    expect(body.data.results.length).toBeGreaterThan(0);
    expect(body.data.results[0]!.studentUserId).toEqual(expect.any(String));
    expect(body.data.results[0]!.marksAwarded).not.toBeUndefined();
  });

  it("says how many marks are still with the teacher, rather than sending a partial total as final", async () => {
    const world = await makeWorld({ withWritten: true });
    await sit(world);
    await releaseResults(teacherOf(world), world.assignmentId);
    const endpoint = await endpointFor(world, ["RESULTS_RELEASED"]);

    const { calls, fetchImpl } = receiver(200);
    await runWebhookDeliveries({ fetchImpl });

    const released = calls.find(
      (call) => call.url === endpoint.url && call.body.includes("results.released"),
    )!;
    const body = JSON.parse(released.body) as {
      data: {
        results: {
          marksAwarded: number | null;
          marksTotal: number | null;
          marksAwaitingMarking: number;
          fullyMarked: boolean;
        }[];
      };
    };

    // `marksAwarded` is what has been DECIDED so far, and the written answer is
    // still with the teacher. Sending it alone would let an MIS print a partial
    // total on a report card as though it were the final mark — the same
    // failure the student's own result page refuses by saying "marked so far".
    const result = body.data.results[0]!;
    expect(result.marksAwaitingMarking).toBe(3);
    expect(result.fullyMarked).toBe(false);
    expect(result.marksAwarded).toBeLessThan(result.marksTotal!);
  });

  it("says a fully objective paper is finished, so a receiver can act on it", async () => {
    const world = await makeWorld();
    await sit(world);
    await releaseResults(teacherOf(world), world.assignmentId);
    const endpoint = await endpointFor(world, ["RESULTS_RELEASED"]);

    const { calls, fetchImpl } = receiver(200);
    await runWebhookDeliveries({ fetchImpl });

    const released = calls.find(
      (call) => call.url === endpoint.url && call.body.includes("results.released"),
    )!;
    const body = JSON.parse(released.body) as {
      data: { results: { marksAwaitingMarking: number; fullyMarked: boolean }[] };
    };
    expect(body.data.results[0]!.marksAwaitingMarking).toBe(0);
    expect(body.data.results[0]!.fullyMarked).toBe(true);
  });
});

describe("claiming", () => {
  it("hands a job to one runner only", async () => {
    const world = await makeWorld();
    await endpointFor(world, ["ASSESSMENT_PUBLISHED", "STUDENT_ENROLLED"]);

    // Queue the jobs without delivering them: a failing receiver leaves them
    // PENDING but attempted, so a second claim would be visible.
    const failing = receiver(500);
    await runWebhookDeliveries({ fetchImpl: failing.fetchImpl });

    const later = new Date(Date.now() + 12 * 60 * 60 * 1000);
    const first = await withTenant(world.organizationId, (tx) =>
      claim(tx, { queue: WEBHOOK_QUEUE, limit: 10, lockedBy: "a", now: later }),
    );
    const second = await withTenant(world.organizationId, (tx) =>
      claim(tx, { queue: WEBHOOK_QUEUE, limit: 10, lockedBy: "b", now: later }),
    );

    expect(first.length).toBeGreaterThan(0);
    // The claim is an UPDATE, so a claimed row is no longer PENDING and the
    // second runner sees nothing. `for update skip locked` is what makes the
    // same statement safe when the two run at the same instant instead.
    expect(second).toHaveLength(0);
    const overlap = second.filter((job) => first.some((other) => other.id === job.id));
    expect(overlap).toHaveLength(0);
  });

  it("counts the attempt on the claim, so a job that kills its runner still dies", async () => {
    const world = await makeWorld();
    const endpoint = await endpointFor(world, ["ASSESSMENT_PUBLISHED"]);

    const failing = receiver(500);
    await runWebhookDeliveries({ fetchImpl: failing.fetchImpl });

    const jobs = await jobsFor(world, endpoint.id);
    expect(jobs[0]!.attempts).toBe(1);
  });
});

describe("the console can see it failing", () => {
  it("counts what is waiting, what gave up, and when the next try is", async () => {
    const world = await makeWorld();
    await endpointFor(world, ["ASSESSMENT_PUBLISHED"]);

    const failing = receiver(500);
    await runWebhookDeliveries({ fetchImpl: failing.fetchImpl });

    const [summary] = await listEndpoints(world.organizationId);
    expect(summary!.health.pending).toBe(1);
    expect(summary!.health.lastOutcome).toBe("retrying");
    expect(summary!.health.nextRetryAt).toBeInstanceOf(Date);
    expect(summary!.health.lastProblem).toBeTruthy();
  });

  it("never shows the receiver's own words", async () => {
    const world = await makeWorld();
    const endpoint = await endpointFor(world, ["ASSESSMENT_PUBLISHED"]);

    const leaky = "TypeError: cannot read studentId at /srv/mis/import.js:44";
    const fetchImpl = (async () =>
      new Response(leaky, { status: 500 })) as unknown as typeof fetch;
    await runWebhookDeliveries({ fetchImpl });

    const log = await deliveryLog(world.organizationId, endpoint.id);
    expect(log!.deliveries).toHaveLength(1);
    expect(log!.deliveries[0]!.problem).toBeTruthy();
    expect(log!.deliveries[0]!.problem).not.toContain("studentId");
    expect(log!.deliveries[0]!.problem).not.toContain("/srv/mis");
    // The machine code is fine to show — it is ours.
    expect(log!.deliveries[0]!.problemCode).toBe("http:500");

    // And the raw text IS kept for us, because "it failed" is not a support
    // answer either.
    const jobs = await jobsFor(world, endpoint.id);
    expect(jobs[0]!.lastError).toContain("studentId");
  });

  it("lists a refusal rather than hiding it — silence looks identical to a bug", async () => {
    const world = await makeWorld();
    const endpoint = await endpointFor(world, ["ASSESSMENT_PUBLISHED"]);

    const failing = receiver(500);
    await runWebhookDeliveries({ fetchImpl: failing.fetchImpl });
    await updateEndpoint({ ...teacherOf(world), role: "OWNER" }, endpoint.id, {
      active: false,
    });
    const later = new Date(Date.now() + 12 * 60 * 60 * 1000);
    await runWebhookDeliveries({ now: later, fetchImpl: failing.fetchImpl });

    const log = await deliveryLog(world.organizationId, endpoint.id);
    expect(log!.deliveries[0]!.status).toBe("FAILED");
    expect(log!.deliveries[0]!.problem).toContain("switched off");
  });
});

describe("the secret", () => {
  it("is returned once and never by a read path", async () => {
    const world = await makeWorld();
    const endpoint = await endpointFor(world, ["ASSESSMENT_PUBLISHED"]);
    expect(endpoint.secret).toMatch(/^whsec_/);

    const listed = await listEndpoints(world.organizationId);
    expect(JSON.stringify(listed)).not.toContain(endpoint.secret);

    const log = await deliveryLog(world.organizationId, endpoint.id);
    expect(JSON.stringify(log)).not.toContain(endpoint.secret);
  });

  it("rotates, and the next delivery is signed with the new one", async () => {
    const world = await makeWorld();
    const endpoint = await endpointFor(world, ["ASSESSMENT_PUBLISHED"]);

    const rotated = await rotateSecret({ ...teacherOf(world), role: "OWNER" }, endpoint.id);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    expect(rotated.secret).not.toEqual(endpoint.secret);

    const { calls, fetchImpl } = receiver(200);
    await runWebhookDeliveries({ fetchImpl });

    const call = calls.find((c) => c.url === endpoint.url)!;
    const timestamp = Number(call.headers.get(TIMESTAMP_HEADER));
    const header = call.headers.get(SIGNATURE_HEADER)!;

    expect(
      verifySignature({
        secret: rotated.secret,
        timestampSeconds: timestamp,
        body: call.body,
        header,
        now: timestamp,
      }),
    ).toBe(true);
    // The old key stops working immediately. There is deliberately no overlap
    // window — a second valid secret is a second key to expire and forget.
    expect(
      verifySignature({
        secret: endpoint.secret,
        timestampSeconds: timestamp,
        body: call.body,
        header,
        now: timestamp,
      }),
    ).toBe(false);
  });
});

describe("tenancy", () => {
  it("shows one school nothing of another's integrations, events or jobs", async () => {
    const mine = await makeWorld();
    const theirs = await makeWorld();

    const endpoint = await endpointFor(mine, ["ASSESSMENT_PUBLISHED"]);
    const failing = receiver(500);
    await runWebhookDeliveries({ fetchImpl: failing.fetchImpl });

    // Every read below is scoped to the other organization, and every one of
    // them is answered by the policy rather than by a WHERE clause we
    // remembered to write.
    const otherEndpoints = await listEndpoints(theirs.organizationId);
    expect(otherEndpoints.some((row) => row.id === endpoint.id)).toBe(false);

    expect(await deliveryLog(theirs.organizationId, endpoint.id)).toBeNull();

    const crossJobs = await withTenant(theirs.organizationId, (tx) =>
      tx.job.findMany({
        where: { payload: { path: ["endpointId"], equals: endpoint.id } },
      }),
    );
    expect(crossJobs).toHaveLength(0);

    const mineEvents = await outboxFor(mine);
    const theirsEvents = await outboxFor(theirs);
    const overlap = theirsEvents.filter((event) =>
      mineEvents.some((other) => other.id === event.id),
    );
    expect(overlap).toHaveLength(0);
  });

  it("cannot be switched off by somebody in another school", async () => {
    const mine = await makeWorld();
    const theirs = await makeWorld();
    const endpoint = await endpointFor(mine, ["ASSESSMENT_PUBLISHED"]);

    const result = await updateEndpoint(
      { ...teacherOf(theirs), role: "OWNER" },
      endpoint.id,
      { active: false },
    );
    // Not found, not forbidden: a 403 would confirm the row exists.
    expect(result.ok).toBe(false);

    const [still] = await listEndpoints(mine.organizationId);
    expect(still!.active).toBe(true);
  });
});
