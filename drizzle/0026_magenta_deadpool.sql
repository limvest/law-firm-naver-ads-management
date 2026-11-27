CREATE TABLE "firm_collection_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"operation_job_id" uuid NOT NULL,
	"request_key" text NOT NULL,
	"active_key" text,
	"requested_by" text DEFAULT 'firm-client' NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"period_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"source_run_ids" jsonb,
	"source_run_count" integer DEFAULT 0 NOT NULL,
	"items_seen" integer DEFAULT 0 NOT NULL,
	"items_accepted" integer DEFAULT 0 NOT NULL,
	"billable_units" integer DEFAULT 1 NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "firm_collection_runs_operation_job" UNIQUE("operation_job_id"),
	CONSTRAINT "firm_collection_runs_request_key" UNIQUE("request_key"),
	CONSTRAINT "firm_collection_runs_one_active" UNIQUE("active_key")
);
--> statement-breakpoint
ALTER TABLE "firm_collection_runs" ADD CONSTRAINT "firm_collection_runs_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_collection_runs" ADD CONSTRAINT "firm_collection_runs_operation_job_id_operation_jobs_id_fk" FOREIGN KEY ("operation_job_id") REFERENCES "public"."operation_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "firm_collection_runs_firm_period_idx" ON "firm_collection_runs" USING btree ("firm_id","period_key","requested_at");--> statement-breakpoint
CREATE INDEX "firm_collection_runs_status_requested_idx" ON "firm_collection_runs" USING btree ("status","requested_at");