CREATE TABLE "persona_skills" (
	"persona_id" uuid,
	"skill_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "persona_skills_pkey" PRIMARY KEY("persona_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "personas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personas_name_check" CHECK (char_length("name") between 1 and 80)
);
--> statement-breakpoint
CREATE INDEX "persona_skills_skill_id_idx" ON "persona_skills" ("skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "personas_user_id_name_key" ON "personas" ("user_id",lower("name"));--> statement-breakpoint
ALTER TABLE "persona_skills" ADD CONSTRAINT "persona_skills_persona_id_personas_id_fkey" FOREIGN KEY ("persona_id") REFERENCES "personas"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "persona_skills" ADD CONSTRAINT "persona_skills_skill_id_skills_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "personas" ADD CONSTRAINT "personas_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;