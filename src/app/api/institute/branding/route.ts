import { saveBranding } from "@/core/branding";
import { expireBrand } from "@/app/_branding/cache-tag";
import { guard } from "../../_lib/guard";
import { fail, ok } from "../../_lib/respond";

export const runtime = "nodejs";

/**
 * Save a school's branding: its details and its theme, together.
 *
 * Guarded twice, and each says something different. `organization:update`
 * says this person may change how the school is configured, and `white_label`,
 * checked inside `saveBranding`, says the plan includes branding at all — a
 * refusal there is a 404, as everywhere a plan gate refuses.
 *
 * It is NOT gated on `admin_console`. The editor is reachable from the
 * teacher's Settings page as well as the console, and a plan that included
 * branding without the console would otherwise show an editor that cannot
 * save.
 *
 * The body's shape is validated in core, by the same pure functions the editor
 * runs while a colour is being picked — so a refusal here is one the form could
 * already have shown, with the same words.
 */
export async function PUT(request: Request) {
  const check = await guard("organization:update");
  if (!check.ok) return check.response;

  const body = (await request.json().catch(() => null)) as
    | { details?: unknown; theme?: unknown }
    | null;
  if (!body || typeof body !== "object") {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }

  const result = await saveBranding(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
      role: check.session.actor.role,
    },
    { details: body.details, theme: body.theme },
  );

  if (!result.ok) {
    if (result.reason === "not-entitled") return fail("NOT_FOUND", "We could not find that.");
    return fail("VALIDATION_FAILED", result.message, { errors: result.errors });
  }

  expireBrand(check.session.actor.organizationId);
  return ok({ saved: true, warnings: result.warnings });
}
