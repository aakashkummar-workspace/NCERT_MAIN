import { z } from "zod";
import {
  approveQuestion,
  archiveQuestion,
  getQuestion,
  rejectQuestion,
  updateQuestion,
} from "@/core/questions";
import { guard, notFound } from "../../_lib/guard";
import { fail, failValidation, ok } from "../../_lib/respond";
import { QuestionBody } from "../route";

export const runtime = "nodejs";

const ActionBody = z.object({
  action: z.enum(["approve", "reject", "archive"]),
  reason: z.string().max(500).optional(),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { id } = await params;
  const question = await getQuestion(check.session.actor.organizationId, id);
  if (!question) return notFound("question");

  return ok(question);
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { id } = await params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }

  const parsed = QuestionBody.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const result = await updateQuestion(check.session.actor, id, parsed.data);

  if (!result.ok && result.code === "NOT_FOUND") return notFound("question");
  if (!result.ok && result.code === "MISFILED") {
    return fail("VALIDATION_FAILED", result.message);
  }
  if (!result.ok) {
    return fail("VALIDATION_FAILED", "This question cannot be saved yet.", {
      problems: result.problems.problems,
    });
  }

  return ok({ version: result.version });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { id } = await params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }

  const parsed = ActionBody.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  if (parsed.data.action === "approve") {
    const result = await approveQuestion(check.session.actor, id);
    if (!result.ok && result.code === "NOT_FOUND") return notFound("question");
    if (!result.ok) {
      return fail(
        "CONFLICT",
        "This question is not ready to be approved.",
        { problems: result.problems.problems },
      );
    }
    return ok({ approved: true });
  }

  if (parsed.data.action === "reject") {
    const reason = parsed.data.reason?.trim();
    if (!reason) {
      // A rejection with no reason is a dead end for whoever wrote it.
      return fail("VALIDATION_FAILED", "Say why, so it can be fixed.");
    }
    const rejected = await rejectQuestion(check.session.actor, id, reason);
    if (!rejected) return notFound("question");
    return ok({ rejected: true });
  }

  const archived = await archiveQuestion(check.session.actor, id);
  if (!archived) return notFound("question");
  return ok({ archived: true });
}
