ALTER TABLE "rounds" ADD COLUMN "self_rating" smallint;--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "rating_note" text;--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_self_rating_check" CHECK ("self_rating" between 1 and 5);--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_rating_note_check" CHECK (char_length("rating_note") <= 2000);