ALTER TABLE "firm_keywords" ADD COLUMN "ad_desired" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "firms" ADD COLUMN "ad_config" jsonb;