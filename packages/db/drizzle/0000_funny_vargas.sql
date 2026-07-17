CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent" text NOT NULL,
	"queue" text,
	"entity_kind" text,
	"entity_id" uuid,
	"status" text NOT NULL,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(12, 6),
	"duration_ms" integer,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"service" text NOT NULL,
	"endpoint" text NOT NULL,
	"units" numeric(12, 4) NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"approval_id" uuid NOT NULL,
	"event" text NOT NULL,
	"actor" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brief_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"tg_message_id" bigint,
	"decided_by_tg_user_id" bigint,
	"decided_via" text,
	"decided_at" timestamp with time zone,
	"reject_reason" text,
	"edit_instructions" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brief_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"r2_key" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" bigint,
	"duration_sec" numeric(8, 2),
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"license_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "briefs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trend_id" uuid,
	"category_id" uuid NOT NULL,
	"origin_kind" text DEFAULT 'trend' NOT NULL,
	"campaign_id" uuid,
	"long_form_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"angle" text NOT NULL,
	"format_slug" text NOT NULL,
	"target_platforms" jsonb NOT NULL,
	"playbook_version_id" uuid,
	"blocked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_clips" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"submitted_url" text,
	"submitted_at" timestamp with time zone,
	"payout_usd" numeric(12, 2),
	"payout_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"marketplace" text DEFAULT 'whop' NOT NULL,
	"category_id" uuid,
	"rate_per_1k" numeric(8, 4),
	"budget_usd" numeric(12, 2),
	"rules_url" text,
	"rules_note" text,
	"source_footage_note" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"mode" text NOT NULL,
	"auto_approve_formats" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cadence_caps" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "clip_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"long_form_id" uuid,
	"campaign_id" uuid,
	"start_sec" numeric(9, 2) NOT NULL,
	"end_sec" numeric(9, 2) NOT NULL,
	"hook_score" integer NOT NULL,
	"self_contained_score" integer NOT NULL,
	"emotion_score" integer NOT NULL,
	"transcript_slice" text,
	"brief_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brief_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"pass" boolean NOT NULL,
	"results" jsonb NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engagements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"post_id" uuid NOT NULL,
	"external_comment_id" text NOT NULL,
	"author" text,
	"text" text,
	"replied_text" text,
	"replied_at" timestamp with time zone,
	"needs_human" boolean DEFAULT false NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"raw_item_id" uuid NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"views" bigint,
	"likes" bigint,
	"comments" bigint,
	"shares" bigint,
	"score" integer
);
--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"purpose" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"units" numeric(12, 4),
	"cost_usd" numeric(12, 6) NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "long_forms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"category_id" uuid NOT NULL,
	"title" text NOT NULL,
	"r2_key" text NOT NULL,
	"duration_sec" integer,
	"transcript_r2_key" text,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playbook_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"category_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"markdown" text NOT NULL,
	"change_summary" text,
	"created_by" text DEFAULT 'system' NOT NULL,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_pages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"last_hash" text,
	"last_checked_at" timestamp with time zone,
	"last_changed_at" timestamp with time zone,
	"last_diff_summary" text,
	CONSTRAINT "policy_pages_url_unique" UNIQUE("url")
);
--> statement-breakpoint
CREATE TABLE "post_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"post_id" uuid NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"views" bigint,
	"likes" bigint,
	"comments" bigint,
	"shares" bigint,
	"watch_time_sec" bigint,
	"avg_view_duration_sec" numeric(8, 2),
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brief_id" uuid NOT NULL,
	"render_id" uuid,
	"category_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"published_at" timestamp with time zone,
	"ayrshare_post_id" text,
	"external_id" text,
	"permalink" text,
	"caption_used" jsonb,
	"fail_reason" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"source_id" uuid,
	"category_id" uuid NOT NULL,
	"url" text NOT NULL,
	"author" text,
	"title" text,
	"text" text,
	"media_type" text,
	"thumbnail_url" text,
	"duration_sec" integer,
	"published_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"embedding" jsonb,
	"trend_id" uuid
);
--> statement-breakpoint
CREATE TABLE "renders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brief_id" uuid NOT NULL,
	"script_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"r2_key" text,
	"thumb_r2_key" text,
	"width" integer,
	"height" integer,
	"duration_sec" numeric(8, 2),
	"bytes" bigint,
	"ffmpeg_log" text,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scripts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brief_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"hook_variants" jsonb NOT NULL,
	"chosen_hook" text,
	"body" text NOT NULL,
	"scene_count" integer NOT NULL,
	"est_duration_sec" integer NOT NULL,
	"per_platform_captions" jsonb NOT NULL,
	"similarity_report" jsonb,
	"ai_disclosure" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"category_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"scout_interval_min" integer DEFAULT 60 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_scouted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trend_members" (
	"trend_id" uuid NOT NULL,
	"raw_item_id" uuid NOT NULL,
	"similarity" numeric(5, 4),
	CONSTRAINT "trend_members_trend_id_raw_item_id_pk" PRIMARY KEY("trend_id","raw_item_id")
);
--> statement-breakpoint
CREATE TABLE "trends" (
	"id" uuid PRIMARY KEY NOT NULL,
	"category_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"headline" text NOT NULL,
	"summary" text NOT NULL,
	"format_archetype" text,
	"emotions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rights_class" text NOT NULL,
	"rights_note" text,
	"velocity_score" numeric(8, 3),
	"llm_score" integer,
	"transferability" jsonb,
	"longevity" text,
	"peak_estimate_at" timestamp with time zone,
	"first_detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_events" ADD CONSTRAINT "approval_events_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_brief_id_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "public"."briefs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_brief_id_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "public"."briefs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_trend_id_trends_id_fk" FOREIGN KEY ("trend_id") REFERENCES "public"."trends"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_long_form_id_long_forms_id_fk" FOREIGN KEY ("long_form_id") REFERENCES "public"."long_forms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_playbook_version_id_playbook_versions_id_fk" FOREIGN KEY ("playbook_version_id") REFERENCES "public"."playbook_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_clips" ADD CONSTRAINT "campaign_clips_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_clips" ADD CONSTRAINT "campaign_clips_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_candidates" ADD CONSTRAINT "clip_candidates_long_form_id_long_forms_id_fk" FOREIGN KEY ("long_form_id") REFERENCES "public"."long_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_candidates" ADD CONSTRAINT "clip_candidates_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_candidates" ADD CONSTRAINT "clip_candidates_brief_id_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "public"."briefs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_checks" ADD CONSTRAINT "compliance_checks_brief_id_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "public"."briefs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_snapshots" ADD CONSTRAINT "item_snapshots_raw_item_id_raw_items_id_fk" FOREIGN KEY ("raw_item_id") REFERENCES "public"."raw_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "long_forms" ADD CONSTRAINT "long_forms_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_versions" ADD CONSTRAINT "playbook_versions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_snapshots" ADD CONSTRAINT "post_snapshots_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_brief_id_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "public"."briefs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_render_id_renders_id_fk" FOREIGN KEY ("render_id") REFERENCES "public"."renders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_items" ADD CONSTRAINT "raw_items_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_items" ADD CONSTRAINT "raw_items_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_items" ADD CONSTRAINT "raw_items_trend_id_trends_id_fk" FOREIGN KEY ("trend_id") REFERENCES "public"."trends"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_brief_id_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "public"."briefs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_script_id_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."scripts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_brief_id_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "public"."briefs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trend_members" ADD CONSTRAINT "trend_members_trend_id_trends_id_fk" FOREIGN KEY ("trend_id") REFERENCES "public"."trends"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trend_members" ADD CONSTRAINT "trend_members_raw_item_id_raw_items_id_fk" FOREIGN KEY ("raw_item_id") REFERENCES "public"."raw_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trends" ADD CONSTRAINT "trends_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_agent_time" ON "agent_runs" USING btree ("agent","started_at");--> statement-breakpoint
CREATE INDEX "api_usage_time" ON "api_usage" USING btree ("at");--> statement-breakpoint
CREATE INDEX "approvals_status" ON "approvals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "assets_brief" ON "assets" USING btree ("brief_id");--> statement-breakpoint
CREATE INDEX "briefs_status" ON "briefs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "briefs_category_created" ON "briefs" USING btree ("category_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "engagements_post_comment" ON "engagements" USING btree ("post_id","external_comment_id");--> statement-breakpoint
CREATE INDEX "item_snapshots_item_time" ON "item_snapshots" USING btree ("raw_item_id","captured_at");--> statement-breakpoint
CREATE INDEX "llm_usage_time" ON "llm_usage" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "playbooks_cat_version" ON "playbook_versions" USING btree ("category_id","version");--> statement-breakpoint
CREATE INDEX "post_snapshots_post_time" ON "post_snapshots" USING btree ("post_id","captured_at");--> statement-breakpoint
CREATE INDEX "posts_status_sched" ON "posts" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "posts_platform_published" ON "posts" USING btree ("platform","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "posts_render_platform" ON "posts" USING btree ("render_id","platform");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_items_platform_ext" ON "raw_items" USING btree ("platform","external_id");--> statement-breakpoint
CREATE INDEX "raw_items_category_seen" ON "raw_items" USING btree ("category_id","first_seen_at");--> statement-breakpoint
CREATE INDEX "raw_items_trend" ON "raw_items" USING btree ("trend_id");--> statement-breakpoint
CREATE INDEX "renders_brief_platform" ON "renders" USING btree ("brief_id","platform");--> statement-breakpoint
CREATE UNIQUE INDEX "scripts_brief_version" ON "scripts" USING btree ("brief_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_uniq" ON "sources" USING btree ("platform","kind","value","category_id");--> statement-breakpoint
CREATE INDEX "trends_cat_status_score" ON "trends" USING btree ("category_id","status","llm_score");