ALTER TABLE "engagement_sessions" ADD COLUMN IF NOT EXISTS "ip_address" text;
--> statement-breakpoint
ALTER TABLE "engagement_sessions" ADD COLUMN IF NOT EXISTS "user_agent" text;
--> statement-breakpoint
ALTER TABLE "engagement_sessions" ADD COLUMN IF NOT EXISTS "referrer" text;
