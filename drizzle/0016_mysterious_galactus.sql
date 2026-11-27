CREATE TABLE "case_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_entity_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"normalized_alias" text NOT NULL,
	"kind" text DEFAULT 'observed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_aliases_case_normalized" UNIQUE("case_entity_id","normalized_alias")
);
--> statement-breakpoint
CREATE TABLE "case_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_entity_id" uuid NOT NULL,
	"firm_id" integer,
	"decision" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"policy_version" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_keyword_id" uuid,
	"canonical_name" text NOT NULL,
	"slug" text NOT NULL,
	"category" text NOT NULL,
	"status" text DEFAULT 'observed' NOT NULL,
	"confidence" integer DEFAULT 0 NOT NULL,
	"merged_into_id" uuid,
	"first_seen_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_entities_legacy_keyword" UNIQUE("legacy_keyword_id"),
	CONSTRAINT "case_entities_slug" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "case_entity_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_entity_id" uuid NOT NULL,
	"relation_type" text NOT NULL,
	"value" text NOT NULL,
	"normalized_value" text NOT NULL,
	"source_observation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_entity_links_case_type_value" UNIQUE("case_entity_id","relation_type","normalized_value")
);
--> statement-breakpoint
CREATE TABLE "case_evidence_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_entity_id" uuid NOT NULL,
	"observation_count" integer DEFAULT 0 NOT NULL,
	"independent_source_count" integer DEFAULT 0 NOT NULL,
	"confidence" integer DEFAULT 0 NOT NULL,
	"facts" jsonb NOT NULL,
	"policy_version" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_entity_id" uuid NOT NULL,
	"firm_id" integer,
	"scope_key" text NOT NULL,
	"score" integer NOT NULL,
	"recommendation" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"input_snapshot" jsonb NOT NULL,
	"model_version" text NOT NULL,
	"calculated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_opportunities_case_scope" UNIQUE("case_entity_id","scope_key")
);
--> statement-breakpoint
CREATE TABLE "content_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"case_entity_id" uuid NOT NULL,
	"asset_type" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"template_version" text NOT NULL,
	"content_version" integer DEFAULT 1 NOT NULL,
	"evidence_snapshot_id" uuid,
	"content" jsonb NOT NULL,
	"quality_report" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_assets_firm_case_type_version" UNIQUE("firm_id","case_entity_id","asset_type","content_version")
);
--> statement-breakpoint
CREATE TABLE "intelligence_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_key" text NOT NULL,
	"name" text NOT NULL,
	"source_type" text NOT NULL,
	"source_family" text,
	"base_url" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"cadence_minutes" integer,
	"config" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intelligence_sources_source_key" UNIQUE("source_key")
);
--> statement-breakpoint
CREATE TABLE "operation_job_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"worker_id" text NOT NULL,
	"state" text NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "operation_job_attempts_job_attempt" UNIQUE("job_id","attempt")
);
--> statement-breakpoint
CREATE TABLE "operation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_type" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"firm_id" integer,
	"case_entity_id" uuid,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "operation_jobs_idempotency" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"firm_id" integer,
	"actor" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"correlation_id" text,
	"causation_id" text,
	"schema_version" text NOT NULL,
	"policy_version" text,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"publish_attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "outbox_events_idempotency" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "publication_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publication_id" uuid NOT NULL,
	"status_code" integer,
	"canonical_ok" boolean DEFAULT false NOT NULL,
	"cta_ok" boolean DEFAULT false NOT NULL,
	"brand_ok" boolean DEFAULT false NOT NULL,
	"placeholder_free" boolean DEFAULT false NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"content_asset_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"url" text NOT NULL,
	"canonical_url" text NOT NULL,
	"index_policy" text DEFAULT 'noindex' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"deployed_version" text,
	"last_error" text,
	"published_at" timestamp with time zone,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publications_firm_url" UNIQUE("firm_id","url")
);
--> statement-breakpoint
CREATE TABLE "source_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_run_id" uuid NOT NULL,
	"source_item_key" text NOT NULL,
	"source_url" text,
	"fingerprint" text NOT NULL,
	"title" text,
	"payload" jsonb,
	"status" text DEFAULT 'observed' NOT NULL,
	"case_entity_id" uuid,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_items_run_item" UNIQUE("source_run_id","source_item_key")
);
--> statement-breakpoint
CREATE TABLE "source_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"checkpoint_before" jsonb,
	"checkpoint_after" jsonb,
	"items_seen" integer DEFAULT 0 NOT NULL,
	"items_accepted" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "case_aliases" ADD CONSTRAINT "case_aliases_case_entity_id_case_entities_id_fk" FOREIGN KEY ("case_entity_id") REFERENCES "public"."case_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_approvals" ADD CONSTRAINT "case_approvals_case_entity_id_case_entities_id_fk" FOREIGN KEY ("case_entity_id") REFERENCES "public"."case_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_approvals" ADD CONSTRAINT "case_approvals_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_entities" ADD CONSTRAINT "case_entities_legacy_keyword_id_keywords_id_fk" FOREIGN KEY ("legacy_keyword_id") REFERENCES "public"."keywords"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_entity_links" ADD CONSTRAINT "case_entity_links_case_entity_id_case_entities_id_fk" FOREIGN KEY ("case_entity_id") REFERENCES "public"."case_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_entity_links" ADD CONSTRAINT "case_entity_links_source_observation_id_observations_id_fk" FOREIGN KEY ("source_observation_id") REFERENCES "public"."observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_evidence_snapshots" ADD CONSTRAINT "case_evidence_snapshots_case_entity_id_case_entities_id_fk" FOREIGN KEY ("case_entity_id") REFERENCES "public"."case_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_opportunities" ADD CONSTRAINT "case_opportunities_case_entity_id_case_entities_id_fk" FOREIGN KEY ("case_entity_id") REFERENCES "public"."case_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_opportunities" ADD CONSTRAINT "case_opportunities_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_assets" ADD CONSTRAINT "content_assets_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_assets" ADD CONSTRAINT "content_assets_case_entity_id_case_entities_id_fk" FOREIGN KEY ("case_entity_id") REFERENCES "public"."case_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_assets" ADD CONSTRAINT "content_assets_evidence_snapshot_id_case_evidence_snapshots_id_fk" FOREIGN KEY ("evidence_snapshot_id") REFERENCES "public"."case_evidence_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_job_attempts" ADD CONSTRAINT "operation_job_attempts_job_id_operation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."operation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_jobs" ADD CONSTRAINT "operation_jobs_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_jobs" ADD CONSTRAINT "operation_jobs_case_entity_id_case_entities_id_fk" FOREIGN KEY ("case_entity_id") REFERENCES "public"."case_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_checks" ADD CONSTRAINT "publication_checks_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_content_asset_id_content_assets_id_fk" FOREIGN KEY ("content_asset_id") REFERENCES "public"."content_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_items" ADD CONSTRAINT "source_items_source_run_id_source_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."source_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_items" ADD CONSTRAINT "source_items_case_entity_id_case_entities_id_fk" FOREIGN KEY ("case_entity_id") REFERENCES "public"."case_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_runs" ADD CONSTRAINT "source_runs_source_id_intelligence_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."intelligence_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "case_aliases_normalized_idx" ON "case_aliases" USING btree ("normalized_alias");--> statement-breakpoint
CREATE INDEX "case_approvals_case_firm_created_idx" ON "case_approvals" USING btree ("case_entity_id","firm_id","created_at");--> statement-breakpoint
CREATE INDEX "case_entities_status_last_seen_idx" ON "case_entities" USING btree ("status","last_seen_at");--> statement-breakpoint
CREATE INDEX "case_entity_links_type_value_idx" ON "case_entity_links" USING btree ("relation_type","normalized_value");--> statement-breakpoint
CREATE INDEX "case_evidence_case_captured_idx" ON "case_evidence_snapshots" USING btree ("case_entity_id","captured_at");--> statement-breakpoint
CREATE INDEX "case_opportunities_firm_score_idx" ON "case_opportunities" USING btree ("firm_id","score");--> statement-breakpoint
CREATE INDEX "content_assets_firm_status_idx" ON "content_assets" USING btree ("firm_id","status");--> statement-breakpoint
CREATE INDEX "operation_job_attempts_job_started_idx" ON "operation_job_attempts" USING btree ("job_id","started_at");--> statement-breakpoint
CREATE INDEX "operation_jobs_claim_idx" ON "operation_jobs" USING btree ("state","available_at","priority");--> statement-breakpoint
CREATE INDEX "operation_jobs_firm_state_idx" ON "operation_jobs" USING btree ("firm_id","state");--> statement-breakpoint
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events" USING btree ("published_at","recorded_at");--> statement-breakpoint
CREATE INDEX "publication_checks_publication_checked_idx" ON "publication_checks" USING btree ("publication_id","checked_at");--> statement-breakpoint
CREATE INDEX "publications_firm_status_idx" ON "publications" USING btree ("firm_id","status");--> statement-breakpoint
CREATE INDEX "source_items_fingerprint_idx" ON "source_items" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "source_items_case_idx" ON "source_items" USING btree ("case_entity_id");--> statement-breakpoint
CREATE INDEX "source_runs_source_started_idx" ON "source_runs" USING btree ("source_id","started_at");