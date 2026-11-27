ALTER TABLE "firms" ADD COLUMN "lawyers" jsonb;--> statement-breakpoint
ALTER TABLE "firms" ADD COLUMN "wordmark" text;--> statement-breakpoint
ALTER TABLE "firms" ADD COLUMN "landing_ready" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "firms" ADD COLUMN "dashboard_token" text;--> statement-breakpoint
ALTER TABLE "firms" ADD CONSTRAINT "firms_dashboard_token_unique" UNIQUE("dashboard_token");