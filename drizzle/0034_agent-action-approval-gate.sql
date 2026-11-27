CREATE TABLE "agent_action_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_run_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"finding_code" text NOT NULL,
	"rationale" text NOT NULL,
	"payload" jsonb,
	"decided_by" text,
	"decision_note" text,
	"decided_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"execution_run_id" uuid,
	"execution_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_action_proposals_review_source_action" UNIQUE("review_run_id","source_id","action_type")
);
--> statement-breakpoint
ALTER TABLE "agent_action_proposals" ADD CONSTRAINT "agent_action_proposals_review_run_id_agent_runs_id_fk" FOREIGN KEY ("review_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_action_proposals" ADD CONSTRAINT "agent_action_proposals_source_id_intelligence_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."intelligence_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_action_proposals" ADD CONSTRAINT "agent_action_proposals_execution_run_id_agent_runs_id_fk" FOREIGN KEY ("execution_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_action_proposals_status_created_idx" ON "agent_action_proposals" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "agent_action_proposals_source_status_idx" ON "agent_action_proposals" USING btree ("source_id","status");
