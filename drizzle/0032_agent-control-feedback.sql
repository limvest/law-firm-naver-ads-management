ALTER TABLE "agent_runs" ADD COLUMN "agent_type" text DEFAULT 'collection' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "trigger" text DEFAULT 'daily' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "report" jsonb;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "recommendations" jsonb;