-- Release 3 of ADR-0045: drop 'screening' from the enum. Release 2 already folded every row into
-- 'interviewing' and writes no 'screening', but fold any left first, or the cast below would fail.
-- Postgres can't drop an enum value, so the column goes through text while the type is rebuilt;
-- the migrator runs this in one transaction, holding the table until it's done.
UPDATE "applications" SET "status" = 'interviewing' WHERE "status" = 'screening';--> statement-breakpoint
ALTER TABLE "applications" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "applications" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
DROP TYPE "application_status";--> statement-breakpoint
CREATE TYPE "application_status" AS ENUM('saved', 'applied', 'interviewing', 'offer', 'accepted', 'rejected', 'withdrawn');--> statement-breakpoint
ALTER TABLE "applications" ALTER COLUMN "status" SET DATA TYPE "application_status" USING "status"::"application_status";--> statement-breakpoint
ALTER TABLE "applications" ALTER COLUMN "status" SET DEFAULT 'applied'::"application_status";
