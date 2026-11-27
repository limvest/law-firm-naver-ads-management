CREATE TABLE "firm_source_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"source_id" uuid NOT NULL,
	"approved_from_request_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"approved_by" text DEFAULT 'operator-console' NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"operator_note" text,
	"paused_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "firm_source_grants_firm_source" UNIQUE("firm_id","source_id")
);
--> statement-breakpoint
ALTER TABLE "firm_collection_runs" ADD COLUMN "requested_source_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "firm_collection_runs" ADD COLUMN "requested_source_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_collection_requests" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "firm_source_grants" ADD CONSTRAINT "firm_source_grants_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_source_grants" ADD CONSTRAINT "firm_source_grants_source_id_intelligence_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."intelligence_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_source_grants" ADD CONSTRAINT "firm_source_grants_approved_from_request_id_source_collection_requests_id_fk" FOREIGN KEY ("approved_from_request_id") REFERENCES "public"."source_collection_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "firm_source_grants_firm_status_idx" ON "firm_source_grants" USING btree ("firm_id","status");--> statement-breakpoint
CREATE INDEX "firm_source_grants_source_status_idx" ON "firm_source_grants" USING btree ("source_id","status");--> statement-breakpoint
ALTER TABLE "source_collection_requests" ADD CONSTRAINT "source_collection_requests_source_id_intelligence_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."intelligence_sources"("id") ON DELETE set null ON UPDATE no action;
