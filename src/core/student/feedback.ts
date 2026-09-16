import "server-only";
import { withTenant } from "@/db/tenant";

/**
 * Stamp that the student has now seen the teacher's feedback on one sitting.
 *
 * Called by the result page AFTER `studentResult` has authorised the read, and
 * only when the review gate is open — stamping a result whose comments are
 * still withheld would mark as "seen" something the student cannot read, and
 * the "new feedback" prompt would never appear on the day it could.
 *
 * Scoped to the student's own attempt twice: the tenant policy, and
 * `student_user_id` in the WHERE. An attempt id is not a capability, and a
 * student who pastes a classmate's result URL stamps nothing.
 *
 * Raw SQL rather than `attempt.updateMany`, for one reason: Prisma's
 * `@updatedAt` would bump `updated_at`, and opening a result is not a change
 * to the sitting. A row whose "last updated" moves every time the student
 * looks at it answers "when was this last marked" wrongly for everybody else.
 *
 * The clock travels as UTC text and is converted in SQL. The column is a
 * zoneless timestamp holding UTC — what Prisma writes into `graded_at`, which
 * this is compared with — and a JS Date handed to the driver can arrive
 * carrying the machine's +05:30 and lose it in the cast, which would make every
 * comment look five and a half hours "newer" than the moment it was read. The
 * fixture teardown learned this first.
 */
export async function markFeedbackSeen(
  organizationId: string,
  studentUserId: string,
  attemptId: string,
  now = new Date(),
): Promise<void> {
  await withTenant(organizationId, (tx) =>
    tx.$executeRaw`
      update attempts
         set feedback_seen_at = (${now.toISOString()}::timestamptz at time zone 'UTC')
       where id = ${attemptId}::uuid
         and student_user_id = ${studentUserId}::uuid
    `,
  );
}
