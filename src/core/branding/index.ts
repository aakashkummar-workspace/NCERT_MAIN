import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { withTenant } from "@/db/tenant";
import { can } from "@/core/billing/entitlements";
import { writeAudit } from "@/core/identity/audit";
import { BrandingDetails, initials, type BrandingDetailsValue } from "./details";
import { sniffLogo } from "./logo";
import { EMPTY_THEME, storedTheme, themeCss, validateTheme, type Theme, type Finding } from "./theme";

/**
 * White labelling: how a school presents itself.
 *
 * ---------------------------------------------------------------------------
 * Stored is not the same as shown
 * ---------------------------------------------------------------------------
 * What a school typed lives in `organization_branding` for as long as the
 * school does. What RENDERS is that row, gated by the `white_label`
 * entitlement at read time, through `can()` like every other capability. A
 * lapsed plan therefore shows Sahayak's own look without deleting anything, and
 * a renewal brings the school's back without anybody retyping an address.
 *
 * ---------------------------------------------------------------------------
 * The interface is branded; the curriculum and the rules are not
 * ---------------------------------------------------------------------------
 * A school's name replaces ours in the chrome, its colours replace ours in the
 * palette, and its letterhead heads its reports. Nothing here changes what a
 * mastery band means, what a report refuses to say, or the caveat printed at
 * the foot of every sheet — a school's footer is printed above that caveat,
 * never in place of it. Branding is presentation, and the product's claims are
 * not presentation.
 *
 * ---------------------------------------------------------------------------
 * Three things are NOT branded, and they are not oversights
 * ---------------------------------------------------------------------------
 *   - SMS. India's DLT rules match every commercial message against a template
 *     registered under a sender header, and an unregistered word arrives
 *     nowhere (src/sms/templates.ts). A school's name in a sign-in text is a
 *     registration per school, not a string.
 *   - Webhook headers and user agents. They are read by machines that were
 *     configured against them.
 *   - The public landing page and the platform console, which are ours.
 */

export type Actor = { organizationId: string; userId: string; role: string };

/** What the chrome draws. Declared structurally again in `src/ui/Brand.tsx`. */
export type Brand = {
  name: string;
  shortName: string;
  tagline: string | null;
  logoUrl: string | null;
  hidePoweredBy: boolean;
  /** A stylesheet built only from validated hex, or null for the default look. */
  css: string | null;
};

/** The school's letterhead as a report stamps it. */
export type Letterhead = {
  version: 1;
  name: string;
  logoId: string | null;
  tagline: string | null;
  address: string | null;
  affiliationNumber: string | null;
  schoolCode: string | null;
  principalName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  website: string | null;
  reportFooter: string | null;
  signatories: string[];
  hidePoweredBy: boolean;
};

export const WHITE_LABEL = "white_label";

export function logoUrl(logoId: string): string {
  return `/api/branding/logo/${logoId}/`;
}

export function publicLogoUrl(slug: string, logoId: string): string {
  return `/api/public/schools/${encodeURIComponent(slug)}/logo/${logoId}/`;
}

export { initials } from "./details";

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function readRow(organizationId: string) {
  return withTenant(organizationId, async (tx) => {
    const organization = await tx.organization.findFirst({
      where: { id: organizationId },
      select: { name: true, slug: true },
    });
    const branding = await tx.organizationBranding.findFirst({
      where: { organizationId },
    });
    return { organization, branding };
  });
}

/**
 * The branding that renders for this organization, or null for Sahayak's own.
 *
 * Null when the plan does not include it, and null when nothing has been set —
 * both of which mean the same thing on screen.
 */
export async function effectiveBranding(organizationId: string): Promise<Brand | null> {
  const entitled = await can(organizationId, WHITE_LABEL);
  if (!entitled.allowed) return null;

  const { organization, branding } = await readRow(organizationId);
  if (!organization || !branding) return null;

  const name = branding.displayName ?? organization.name;
  const theme = storedTheme(branding.theme);
  return {
    name,
    shortName: branding.shortName ?? initials(name),
    tagline: branding.tagline,
    logoUrl: branding.logoId ? logoUrl(branding.logoId) : null,
    hidePoweredBy: branding.hidePoweredBy,
    css: theme ? themeCss(theme) : null,
  };
}

export type EditorState = {
  entitled: boolean;
  organizationName: string;
  slug: string;
  logoUrl: string | null;
  details: {
    displayName: string;
    shortName: string;
    tagline: string;
    address: string;
    affiliationNumber: string;
    schoolCode: string;
    principalName: string;
    contactPhone: string;
    contactEmail: string;
    website: string;
    reportFooter: string;
    signatories: string[];
    hidePoweredBy: boolean;
  };
  /** As stored — which may be a theme that no longer validates, and says so. */
  theme: Theme;
  storedThemeRenders: boolean;
};

export async function editorState(organizationId: string): Promise<EditorState | null> {
  const entitled = await can(organizationId, WHITE_LABEL);
  const { organization, branding } = await readRow(organizationId);
  if (!organization) return null;

  const verdict = validateTheme(branding?.theme ?? {});
  return {
    entitled: entitled.allowed,
    organizationName: organization.name,
    slug: organization.slug,
    logoUrl: branding?.logoId ? logoUrl(branding.logoId) : null,
    details: {
      displayName: branding?.displayName ?? "",
      shortName: branding?.shortName ?? "",
      tagline: branding?.tagline ?? "",
      address: branding?.address ?? "",
      affiliationNumber: branding?.affiliationNumber ?? "",
      schoolCode: branding?.schoolCode ?? "",
      principalName: branding?.principalName ?? "",
      contactPhone: branding?.contactPhone ?? "",
      contactEmail: branding?.contactEmail ?? "",
      website: branding?.website ?? "",
      reportFooter: branding?.reportFooter ?? "",
      signatories: branding?.signatories ?? [],
      hidePoweredBy: branding?.hidePoweredBy ?? false,
    },
    theme: verdict.ok ? verdict.theme : EMPTY_THEME,
    storedThemeRenders: verdict.ok,
  };
}

/**
 * The letterhead a report written now would carry, or null.
 *
 * Null when the school is not branded, so an unbranded report renders exactly
 * as reports always have.
 */
export async function letterheadFor(organizationId: string): Promise<Letterhead | null> {
  const entitled = await can(organizationId, WHITE_LABEL);
  if (!entitled.allowed) return null;

  const { organization, branding } = await readRow(organizationId);
  if (!organization || !branding) return null;

  return {
    version: 1,
    name: branding.displayName ?? organization.name,
    logoId: branding.logoId,
    tagline: branding.tagline,
    address: branding.address,
    affiliationNumber: branding.affiliationNumber,
    schoolCode: branding.schoolCode,
    principalName: branding.principalName,
    contactPhone: branding.contactPhone,
    contactEmail: branding.contactEmail,
    website: branding.website,
    reportFooter: branding.reportFooter,
    signatories: branding.signatories,
    hidePoweredBy: branding.hidePoweredBy,
  };
}

/**
 * A stored letterhead, or null when it is absent or in a shape this build does
 * not know. A report renders its plain header in either case rather than a
 * letterhead with holes in it.
 */
export function storedLetterhead(value: unknown): Letterhead | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<Letterhead>;
  if (row.version !== 1 || typeof row.name !== "string") return null;
  return row as Letterhead;
}

/**
 * A logo, for a member of the organization that owns it.
 *
 * Any logo the school has ever had, not only the current one: a report stamped
 * in September points at September's logo, and it must still draw.
 */
export async function readLogo(
  organizationId: string,
  logoId: string,
): Promise<{ mime: string; bytes: Uint8Array } | null> {
  const logo = await withTenant(organizationId, (tx) =>
    tx.organizationLogo.findFirst({
      where: { id: logoId },
      select: { mime: true, bytes: true },
    }),
  );
  return logo ? { mime: logo.mime, bytes: logo.bytes } : null;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export type SaveResult =
  | { ok: true; warnings: Finding[] }
  | { ok: false; reason: "not-entitled"; message: string }
  | { ok: false; reason: "invalid"; message: string; errors: Finding[] };

const NOT_ENTITLED = "Your plan does not include your own branding.";

export async function saveBranding(
  actor: Actor,
  input: { details: unknown; theme: unknown },
): Promise<SaveResult> {
  const entitled = await can(actor.organizationId, WHITE_LABEL);
  if (!entitled.allowed) return { ok: false, reason: "not-entitled", message: NOT_ENTITLED };

  const details = BrandingDetails.safeParse(input.details ?? {});
  const theme = validateTheme(input.theme ?? {});

  const errors: Finding[] = [];
  if (!details.success) {
    for (const issue of details.error.issues) {
      errors.push({ field: issue.path.join(".") || "details", message: issue.message });
    }
  }
  if (!theme.ok) errors.push(...theme.errors);

  if (errors.length > 0 || !details.success || !theme.ok) {
    return {
      ok: false,
      reason: "invalid",
      message:
        errors.length === 1
          ? errors[0]!.message
          : `${errors.length} things need changing before this can be saved.`,
      errors,
    };
  }

  const value: BrandingDetailsValue = details.data;
  const data = {
    displayName: value.displayName ?? null,
    shortName: value.shortName ?? null,
    tagline: value.tagline ?? null,
    address: value.address ?? null,
    affiliationNumber: value.affiliationNumber ?? null,
    schoolCode: value.schoolCode ?? null,
    principalName: value.principalName ?? null,
    contactPhone: value.contactPhone ?? null,
    contactEmail: value.contactEmail ?? null,
    website: value.website ?? null,
    reportFooter: value.reportFooter ?? null,
    signatories: value.signatories ?? [],
    hidePoweredBy: value.hidePoweredBy ?? false,
    theme: theme.theme as unknown as object,
    updatedById: actor.userId,
  };

  const before = await withTenant(actor.organizationId, async (tx) => {
    const existing = await tx.organizationBranding.findFirst({
      where: { organizationId: actor.organizationId },
    });
    await tx.organizationBranding.upsert({
      where: { organizationId: actor.organizationId },
      create: { organizationId: actor.organizationId, ...data },
      update: data,
    });
    return existing;
  });

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "branding.updated",
    entityType: "organization",
    entityId: actor.organizationId,
    before: before ? { ...before, createdAt: undefined, updatedAt: undefined } : null,
    after: data,
  });

  return { ok: true, warnings: theme.warnings };
}

export type LogoResult =
  | { ok: true; logoId: string; url: string }
  | { ok: false; reason: "not-entitled" | "invalid"; message: string };

export async function uploadLogo(actor: Actor, bytes: Uint8Array): Promise<LogoResult> {
  const entitled = await can(actor.organizationId, WHITE_LABEL);
  if (!entitled.allowed) return { ok: false, reason: "not-entitled", message: NOT_ENTITLED };

  const sniffed = sniffLogo(bytes);
  if (!sniffed.ok) return { ok: false, reason: "invalid", message: sniffed.message };

  const logoId = randomUUID();
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  await withTenant(actor.organizationId, async (tx) => {
    // createMany, not create: nothing needs the bytes read back.
    await tx.organizationLogo.createMany({
      data: [
        {
          id: logoId,
          organizationId: actor.organizationId,
          mime: sniffed.mime,
          bytes: Buffer.from(bytes),
          byteSize: bytes.byteLength,
          sha256,
          uploadedById: actor.userId,
        },
      ],
    });
    await tx.organizationBranding.upsert({
      where: { organizationId: actor.organizationId },
      create: { organizationId: actor.organizationId, logoId, updatedById: actor.userId },
      update: { logoId, updatedById: actor.userId },
    });
  });

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "branding.logo_uploaded",
    entityType: "organization_logo",
    entityId: logoId,
    after: { mime: sniffed.mime, byteSize: bytes.byteLength, sha256 },
  });

  return { ok: true, logoId, url: logoUrl(logoId) };
}

/**
 * Stop showing a logo. The row is kept — a report stamped with it still draws.
 */
export async function removeLogo(actor: Actor): Promise<{ ok: true } | { ok: false; message: string }> {
  const entitled = await can(actor.organizationId, WHITE_LABEL);
  if (!entitled.allowed) return { ok: false, message: NOT_ENTITLED };

  const previous = await withTenant(actor.organizationId, async (tx) => {
    const existing = await tx.organizationBranding.findFirst({
      where: { organizationId: actor.organizationId },
      select: { logoId: true },
    });
    if (existing?.logoId) {
      await tx.organizationBranding.update({
        where: { organizationId: actor.organizationId },
        data: { logoId: null, updatedById: actor.userId },
      });
    }
    return existing?.logoId ?? null;
  });

  if (previous) {
    await writeAudit({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "branding.logo_removed",
      entityType: "organization_logo",
      entityId: previous,
    });
  }
  return { ok: true };
}
