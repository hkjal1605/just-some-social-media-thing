ALTER TABLE "briefs" ADD COLUMN "studio_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "briefs" ADD COLUMN "caption_preset" text;--> statement-breakpoint
ALTER TABLE "long_forms" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "long_forms" ADD COLUMN "genre" text;--> statement-breakpoint
ALTER TABLE "long_forms" ADD COLUMN "clip_options" jsonb;