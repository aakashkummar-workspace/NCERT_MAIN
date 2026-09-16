/** The last two steps of the mock data: detect gaps, then write term reports. */
import pg from "pg";
import { pgConfig } from "./scripts/lib/pg-connection.ts";
const { detectForClass } = await import("./src/core/gaps/detect.ts");
const { generateForClass } = await import("./src/core/reports/index.ts");

const db = new pg.Pool({ ...pgConfig(process.env.DIRECT_URL!), max: 2 });
const ctx = (await db.query(
  `select o.id org, k.id class, u.id owner from organizations o
     join classes k on k.organization_id = o.id and k.name = 'Class 10-A' and k.deleted_at is null
     join memberships m on m.organization_id = o.id and m.role = 'OWNER'
     join users u on u.id = m.user_id
    where o.slug = 'sirah-digital-ea8a1' limit 1`)).rows[0];
await db.end();

const gaps = await detectForClass(ctx.org, ctx.class);
console.log("gaps:", JSON.stringify(gaps));

const DAY = 86_400_000;
const reports = await generateForClass(
  { organizationId: ctx.org, userId: ctx.owner },
  { classId: ctx.class, periodStart: new Date(Date.now() - 8 * 7 * DAY), periodEnd: new Date() },
);
if (!reports.ok) console.log("reports refused:", reports.message);
else {
  const made = reports.rows.filter((r) => r.reportId).length;
  console.log(`reports: ${made} written, ${reports.rows.length - made} refused`);
  for (const r of reports.rows.filter((r) => !r.reportId)) console.log(`  ${r.fullName}: ${r.skipped}`);
}
process.exit(0);
