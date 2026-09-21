-- CreateEnum
CREATE TYPE "DeliveryMode" AS ENUM ('ONLINE', 'PAPER');

-- AlterEnum
ALTER TYPE "SubmitReason" ADD VALUE 'PAPER';

-- AlterTable
ALTER TABLE "assignments" ADD COLUMN     "delivery_mode" "DeliveryMode" NOT NULL DEFAULT 'ONLINE';
