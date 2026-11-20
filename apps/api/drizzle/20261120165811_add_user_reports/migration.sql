CREATE TABLE "user_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"description" text NOT NULL,
	"reply_email" text,
	"user_id" text,
	"page_path" text NOT NULL,
	"release" text NOT NULL,
	"user_agent" text,
	"client_key" text NOT NULL,
	"issue_requested_at" timestamp with time zone,
	"issue_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "user_reports_client_key_created_at_idx" ON "user_reports" ("client_key","created_at");--> statement-breakpoint
CREATE INDEX "user_reports_issue_requested_at_idx" ON "user_reports" ("issue_requested_at");--> statement-breakpoint
CREATE INDEX "user_reports_created_at_idx" ON "user_reports" ("created_at");