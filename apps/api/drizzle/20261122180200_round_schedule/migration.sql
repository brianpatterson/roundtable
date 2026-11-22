ALTER TABLE "rounds" ADD COLUMN "starts_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "duration_minutes" integer;--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "due_on" date;--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_start_or_due_check" CHECK ("starts_at" is null or "due_on" is null);--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_duration_check" CHECK ("duration_minutes" is null or ("starts_at" is not null and "duration_minutes" between 5 and 480));