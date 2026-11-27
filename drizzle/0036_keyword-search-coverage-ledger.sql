CREATE TABLE "keyword_search_coverage_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"coverage_key" text NOT NULL,
	"run_key" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"eligibility_version" text DEFAULT 'observed-nonblocked-v1' NOT NULL,
	"eligible_seed_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_eligible" integer DEFAULT 0 NOT NULL,
	"processed_count" integer DEFAULT 0 NOT NULL,
	"succeeded_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"pending_retry_count" integer DEFAULT 0 NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"remaining_count" integer DEFAULT 0 NOT NULL,
	"cursor_hint" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "keyword_search_coverage_runs_key" UNIQUE("coverage_key","run_key")
);
--> statement-breakpoint
CREATE INDEX "keyword_search_coverage_runs_key_created_idx" ON "keyword_search_coverage_runs" USING btree ("coverage_key","created_at");
--> statement-breakpoint
CREATE INDEX "keyword_search_coverage_runs_status_updated_idx" ON "keyword_search_coverage_runs" USING btree ("status","updated_at");
--> statement-breakpoint
CREATE TABLE "keyword_search_coverage_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"batch_key" text NOT NULL,
	"batch_number" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"seed_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attempted_seed_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"succeeded_seed_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failed_seed_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"retried_seed_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"retryable_seed_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pending_seed_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"processed_count" integer DEFAULT 0 NOT NULL,
	"remaining_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "keyword_search_coverage_batches_run_key" UNIQUE("run_id","batch_key"),
	CONSTRAINT "keyword_search_coverage_batches_run_number" UNIQUE("run_id","batch_number")
);
--> statement-breakpoint
ALTER TABLE "keyword_search_coverage_batches" ADD CONSTRAINT "keyword_search_coverage_batches_run_id_keyword_search_coverage_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."keyword_search_coverage_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "keyword_search_coverage_batches_run_status_idx" ON "keyword_search_coverage_batches" USING btree ("run_id","status");
--> statement-breakpoint
CREATE INDEX "keyword_search_coverage_batches_updated_idx" ON "keyword_search_coverage_batches" USING btree ("updated_at");
--> statement-breakpoint
CREATE TABLE "keyword_search_coverage_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"attempt_key" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"seed_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"succeeded_seed_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failed_seed_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"retryable_seed_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"processed_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "keyword_search_coverage_attempts_batch_key" UNIQUE("batch_id","attempt_key")
);
--> statement-breakpoint
ALTER TABLE "keyword_search_coverage_attempts" ADD CONSTRAINT "keyword_search_coverage_attempts_batch_id_keyword_search_coverage_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."keyword_search_coverage_batches"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "keyword_search_coverage_attempts_batch_created_idx" ON "keyword_search_coverage_attempts" USING btree ("batch_id","created_at");
