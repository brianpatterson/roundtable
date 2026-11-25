CREATE TABLE "prep_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"round_id" uuid NOT NULL,
	"title" text NOT NULL,
	"skill_id" uuid,
	"position" integer NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prep_tasks_title_check" CHECK (char_length("title") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "prep_notes" text;--> statement-breakpoint
CREATE UNIQUE INDEX "prep_tasks_round_id_position_key" ON "prep_tasks" ("round_id","position");--> statement-breakpoint
ALTER TABLE "prep_tasks" ADD CONSTRAINT "prep_tasks_round_id_rounds_id_fkey" FOREIGN KEY ("round_id") REFERENCES "rounds"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_prep_notes_check" CHECK (char_length("prep_notes") <= 10000);