import { removeLogo, uploadLogo } from "@/core/branding";
import { MAX_LOGO_BYTES } from "@/core/branding/logo";
import { expireBrand } from "@/app/_branding/cache-tag";
import { guard } from "../../../_lib/guard";
import { fail, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

// The plan gate is `white_label`, checked inside core — not `admin_console`,
// because the editor also lives on the teacher's Settings page.
async function gate() {
  return guard("organization:update");
}

/**
 * Upload a logo, as `multipart/form-data` with one part named `file`.
 *
 * The declared type and the filename are ignored: `sniffLogo` decides from the
 * file's own first bytes. The size is checked against the declared length
 * before anything is buffered, and again against the bytes actually read,
 * because a Content-Length header is also just something the client said.
 */
export async function POST(request: Request) {
  const check = await gate();
  if (!check.ok) return check.response;

  const declared = Number(request.headers.get("content-length") ?? 0);
  // Multipart framing adds a few hundred bytes around the file itself.
  if (declared > MAX_LOGO_BYTES + 16 * 1024) {
    return fail("VALIDATION_FAILED", `A logo can be at most ${MAX_LOGO_BYTES / 1024} KB.`);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail("VALIDATION_FAILED", "Choose an image file to upload.");
  }
  const file = form.get("file");
  if (!file || typeof file === "string") {
    return fail("VALIDATION_FAILED", "Choose an image file to upload.");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await uploadLogo(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
      role: check.session.actor.role,
    },
    bytes,
  );

  if (!result.ok) {
    if (result.reason === "not-entitled") return fail("NOT_FOUND", "We could not find that.");
    return fail("VALIDATION_FAILED", result.message);
  }
  expireBrand(check.session.actor.organizationId);
  return ok({ logoId: result.logoId, url: result.url });
}

/** Stop showing the logo. The file itself is kept for the reports that used it. */
export async function DELETE() {
  const check = await gate();
  if (!check.ok) return check.response;

  const result = await removeLogo({
    organizationId: check.session.actor.organizationId,
    userId: check.session.actor.userId,
    role: check.session.actor.role,
  });
  if (!result.ok) return fail("NOT_FOUND", "We could not find that.");
  expireBrand(check.session.actor.organizationId);
  return ok({ removed: true });
}
