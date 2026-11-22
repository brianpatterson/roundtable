CREATE TYPE "interview_type" AS ENUM('recruiter_screen', 'hiring_manager', 'coding', 'system_design', 'behavioral', 'take_home', 'presentation', 'other');--> statement-breakpoint
CREATE TABLE "rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"application_id" uuid NOT NULL,
	"interview_type" "interview_type" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rounds_application_id_created_at_idx" ON "rounds" ("application_id","created_at");--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_application_id_applications_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE;