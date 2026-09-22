import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { acceptInvitation, inviteParent, revokeLink } from "@/core/parent/link";
import { digestState, setDigest } from "@/core/digest";
import { sendWeeklyDigests } from "@/core/digest/jobs";
import { meetingBrief } from "@/core/reports";
import { getPlayer, saveAnswers, startAttempt, submitAttempt } from "@/core/attempts";
import { setWhatsappProvider } from "@/whatsapp/gateway";
import type { WhatsappProvider, WhatsappRequest } from "@/whatsapp/provider";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { makeWorld, studentOf, teacherOf, type World } from "./support/world";

afterAll(async () => {
  await prisma.$disconnect();
});
afterEach(() => setWhatsappProvider(undefined));

const phone = () => `9${String(Date.now() + Math.floor(Math.random() * 99999)).slice(-9)}`;

class RecordingProvider implements WhatsappProvider {
  readonly name = "recording";
  readonly sent: WhatsappRequest[] = [];
  async send(request: WhatsappRequest) {
    this.sent.push(request);
    return { ok: true as const, providerMessageId: `wamid.${this.sent.length}` };
  }
}

async function linkedParent(world: World) {
  const userId = randomUUID();
  const number = phone();
  await withTenant(world.organizationId, async (tx) => {
    await tx.user.createMany({ data: [{ id: userId, fullName: "Parent", status: "ACTIVE", phone: number }] });
    await tx.membership.createMany({
      data: [{ id: randomUUID(), organizationId: world.organizationId, userId, role: "PARENT", status: "ACTIVE", joinedAt: new Date() }],
    });
  });
  const invited = await inviteParent(teacherOf(world), { studentUserId: world.studentId, phone: number, relationship: "MOTHER" });
  if (!invited.ok) throw new Error(invited.message);
  const accepted = await acceptInvitation(invited.token, number, userId);
  if (!accepted.ok) throw new Error(accepted.message);
  return { organizationId: world.organizationId, userId };
}

async function sitAndRelease(world: World) {
  const started = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
  if (!started.ok) throw new Error(started.message);
  const player = (await getPlayer(studentOf(world), started.attemptId))!;
  const mcq = player.questions.find((q) => q.type === "MCQ")!;
  await saveAnswers(studentOf(world), started.attemptId, [
    { assessmentQuestionId: mcq.assessmentQuestionId, response: { kind: "choice", keys: ["B"] }, clientSeq: 1 },
  ]);
  await submitAttempt(studentOf(world), started.attemptId);
}

async function ledger(world: World) {
  return withTenant(world.organizationId, (tx) => tx.whatsappMessage.findMany());
}

describe("the weekly WhatsApp digest", () => {
  it("goes only to a parent who opted in, once a week, about a released result", async () => {
    const world = await makeWorld();
    const parent = await linkedParent(world);
    await sitAndRelease(world);
    const provider = new RecordingProvider();
    setWhatsappProvider(provider);

    await sendWeeklyDigests();
    expect(await ledger(world)).toHaveLength(0);

    expect(await setDigest(parent, world.studentId, true)).toBe(true);
    expect(await digestState(parent, world.studentId)).toBe(true);

    await sendWeeklyDigests();
    await sendWeeklyDigests();
    const rows = await ledger(world);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("SENT");
    const mine = provider.sent.filter((request) => request.parameters.some((p) => p.includes("Paper")));
    expect(mine.length).toBeGreaterThan(0);
    // The ledger holds neither the number nor the text.
    expect(JSON.stringify(rows)).not.toMatch(/9\d{9}/);
  });

  it("stops the moment the link is revoked", async () => {
    const world = await makeWorld();
    const parent = await linkedParent(world);
    await sitAndRelease(world);
    await setDigest(parent, world.studentId, true);
    const links = await withTenant(world.organizationId, (tx) =>
      tx.parentStudentLink.findFirstOrThrow({ where: { parentUserId: parent.userId } }),
    );
    await revokeLink(teacherOf(world), links.id);
    setWhatsappProvider(new RecordingProvider());

    await sendWeeklyDigests();
    expect(await ledger(world)).toHaveLength(0);
  });

  it("records a skip, not a send, when no provider is configured", async () => {
    const world = await makeWorld();
    const parent = await linkedParent(world);
    await sitAndRelease(world);
    await setDigest(parent, world.studentId, true);
    setWhatsappProvider(null);

    await sendWeeklyDigests();
    const rows = await ledger(world);
    expect(rows.map((row) => row.status)).toEqual(["SKIPPED"]);
  });

  it("cannot be switched on for somebody else's child", async () => {
    const world = await makeWorld();
    const stranger = { organizationId: world.organizationId, userId: randomUUID() };
    expect(await setDigest(stranger, world.studentId, true)).toBe(false);
  });
});

describe("the parent–teacher meeting brief", () => {
  it("is built for a student with little evidence, and says so", async () => {
    const world = await makeWorld();
    await sitAndRelease(world);
    const brief = await meetingBrief(
      teacherOf(world),
      world.studentId,
      new Date(Date.now() - 90 * 24 * 3600_000),
      new Date(),
    );
    expect(brief).not.toBeNull();
    expect(brief!.talkingPoints[0]).toMatch(/early picture|measured/);
    expect(brief!.papers.length).toBeGreaterThan(0);
  });

  it("refuses a student who is not in this school", async () => {
    const world = await makeWorld();
    const other = await makeWorld();
    expect(await meetingBrief(teacherOf(world), other.studentId, new Date(0), new Date())).toBeNull();
  });
});

describe("beyond marks on a term report", () => {
  it("stamps the latest observation per area, and a later one does not change it", async () => {
    const { measuredWorld } = await import("./support/measured-world");
    const { recordObservations } = await import("@/core/reports/holistic");
    const { generateReport } = await import("@/core/reports");
    const { world } = await measuredWorld();

    await recordObservations(teacherOf(world), world.studentId, [
      { domain: "CURIOSITY", level: "Confident", note: "Asks why the proof works." },
      { domain: "COLLABORATION", level: "Growing", note: null },
    ]);
    const report = await generateReport(teacherOf(world), {
      studentUserId: world.studentId,
      periodStart: new Date("2026-04-01T00:00:00Z"),
      periodEnd: new Date(Date.now() + 60_000),
    });
    if (!report.ok) throw new Error(report.message);
    const holistic = (report.payload as { holistic?: { domain: string; level: string }[] }).holistic;
    expect(holistic?.map((line) => [line.domain, line.level])).toEqual([
      ["CURIOSITY", "Confident"],
      ["COLLABORATION", "Growing"],
    ]);

    await recordObservations(teacherOf(world), world.studentId, [
      { domain: "CURIOSITY", level: "Leading", note: null },
    ]);
    const stored = await withTenant(world.organizationId, (tx) =>
      tx.report.findUniqueOrThrow({ where: { id: report.reportId } }),
    );
    expect(JSON.stringify(stored.payload)).toContain("Confident");
    expect(JSON.stringify(stored.payload)).not.toContain("Leading");
  });

  it("refuses an area or a level that is not on the list", async () => {
    const { recordObservations } = await import("@/core/reports/holistic");
    const world = await makeWorld();
    const result = await recordObservations(teacherOf(world), world.studentId, [
      { domain: "SCORE" as never, level: "10" as never, note: null },
    ]);
    expect(result.ok).toBe(false);
  });
});

describe("APAAR IDs", () => {
  // Unique per school, and every world is its own school — but a random ID
  // still keeps two runs from ever reading each other's.
  const apaar = () => String(Math.floor(1e11 + Math.random() * 9e11));

  it("is set, normalised, shown in both exports, and cleared", async () => {
    const { setApaar, getApaar } = await import("@/core/roster/apaar");
    const { assignmentMarksCsv, classMarksCsv } = await import("@/core/results/export");
    const world = await makeWorld();
    const id = apaar();
    const grouped = `${id.slice(0, 4)} ${id.slice(4, 8)}-${id.slice(8)}`;

    const set = await setApaar(teacherOf(world), world.studentId, grouped);
    expect(set).toEqual({ ok: true, apaarId: id });
    expect(await getApaar(world.organizationId, world.studentId)).toBe(id);

    const file = await assignmentMarksCsv(teacherOf(world), world.assignmentId);
    expect(file!.csv).toContain("apaar_id");
    expect(file!.csv).toContain(id);
    const register = await classMarksCsv(teacherOf(world), world.classId, {
      from: new Date("2026-04-01T00:00:00Z"),
      to: new Date(Date.now() + 60_000),
    });
    expect(register!.csv).toContain(id);

    expect(await setApaar(teacherOf(world), world.studentId, "")).toEqual({ ok: true, apaarId: null });
    expect(await getApaar(world.organizationId, world.studentId)).toBeNull();
  });

  it("refuses a malformed ID, and the same ID on a second student", async () => {
    const { setApaar } = await import("@/core/roster/apaar");
    const world = await makeWorld();
    const id = apaar();

    const bad = await setApaar(teacherOf(world), world.studentId, "12345");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("INVALID");

    expect((await setApaar(teacherOf(world), world.studentId, id)).ok).toBe(true);
    const twice = await setApaar(teacherOf(world), world.otherStudentId, id);
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.code).toBe("TAKEN");
    // Setting it again on the student who holds it is not a clash with themselves.
    expect((await setApaar(teacherOf(world), world.studentId, id)).ok).toBe(true);
  });

  it("allows the same ID in a different school", async () => {
    const { setApaar } = await import("@/core/roster/apaar");
    const first = await makeWorld();
    const second = await makeWorld();
    const id = apaar();
    expect((await setApaar(teacherOf(first), first.studentId, id)).ok).toBe(true);
    expect((await setApaar(teacherOf(second), second.studentId, id)).ok).toBe(true);
  });

  it("refuses a student from another school", async () => {
    const { setApaar } = await import("@/core/roster/apaar");
    const world = await makeWorld();
    const other = await makeWorld();
    const result = await setApaar(teacherOf(world), other.studentId, apaar());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NOT_FOUND");
  });

  it("is imported from a roster column, and a duplicate row is skipped with the reason", async () => {
    const { addStudents } = await import("@/core/roster/add");
    const { parseRoster } = await import("@/core/roster/parse");
    const { getApaar } = await import("@/core/roster/apaar");
    const world = await makeWorld();
    const id = apaar();
    const tag = randomUUID().slice(0, 6);

    const roster = await addStudents(
      teacherOf(world),
      world.classId,
      parseRoster(`Name,APAAR ID\nFirst ${tag},${id}\nSecond ${tag},${id}`).students,
    );
    const added = roster.outcomes.filter((outcome) => outcome.status === "added");
    expect(added).toHaveLength(1);
    const skipped = roster.outcomes.find((outcome) => outcome.status !== "added");
    expect(JSON.stringify(skipped)).toMatch(/APAAR ID/);
    expect(await getApaar(world.organizationId, (added[0] as { userId: string }).userId)).toBe(id);
  });
});
