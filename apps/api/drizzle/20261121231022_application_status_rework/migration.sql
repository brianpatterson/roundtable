ALTER TYPE "application_status" ADD VALUE 'saved' BEFORE 'applied';--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "applied_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
-- Backfill (ADR-0045): until now the creation date doubled as the applied date (ADR-0006). No row
-- is 'saved' yet, and Postgres won't let this transaction use the value it just added anyway.
UPDATE "applications" SET "applied_at" = "created_at";--> statement-breakpoint
-- Fold screening into interviewing. The enum keeps 'screening' until a later release drops it, so
-- the previous release can still write it during a deploy or rollback. updated_at stays as it was.
UPDATE "applications" SET "status" = 'interviewing' WHERE "status" = 'screening';
