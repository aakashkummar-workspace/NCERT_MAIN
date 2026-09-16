-- White labelling: a school's name, logo, colours and official details, and
-- the letterhead stamped onto each report at the moment it is written.
--
-- Both new tables are ordinary tenant tables; their policies are in
-- prisma/rls.sql, and `npm run db:rls` must run after this migration or the
-- RLS audit fails on them — which is the audit doing its job.

-- AlterTable
ALTER TABLE "reports" ADD COLUMN     "letterhead" JSONB;

-- CreateTable
CREATE TABLE "organization_branding" (
    "organization_id" UUID NOT NULL,
    "display_name" TEXT,
    "short_name" TEXT,
    "tagline" TEXT,
    "logo_id" UUID,
    "theme" JSONB NOT NULL DEFAULT '{}',
    "address" TEXT,
    "affiliation_number" TEXT,
    "school_code" TEXT,
    "principal_name" TEXT,
    "contact_phone" TEXT,
    "contact_email" TEXT,
    "website" TEXT,
    "report_footer" TEXT,
    "signatories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hide_powered_by" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_branding_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "organization_logos" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_logos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "organization_logos_organization_id_created_at_idx" ON "organization_logos"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "organization_branding" ADD CONSTRAINT "organization_branding_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_branding" ADD CONSTRAINT "organization_branding_logo_id_fkey" FOREIGN KEY ("logo_id") REFERENCES "organization_logos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_logos" ADD CONSTRAINT "organization_logos_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
