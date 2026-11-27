ALTER TABLE "agent_runs" ADD COLUMN "run_key" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "pipeline_version" text DEFAULT 'agent-orchestrator-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "current_stage" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "stage_events" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_run_key" UNIQUE("run_key");