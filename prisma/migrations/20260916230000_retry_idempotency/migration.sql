-- A mistake retry can be replayed by a device that never heard back.
--
-- The key is minted on the device before the request leaves it, for
-- `client_attempt_id`'s reason: a key the server invents is a new key every
-- time. Matching it returns the recorded verdict and increments nothing.

-- AlterTable
ALTER TABLE "student_mistakes" ADD COLUMN     "last_client_retry_id" UUID;
