CREATE TYPE "round_outcome" AS ENUM('pending', 'passed', 'failed', 'unknown');--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "outcome" "round_outcome" DEFAULT 'pending'::"round_outcome" NOT NULL;--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "outcome_set_by_user" boolean DEFAULT false NOT NULL;