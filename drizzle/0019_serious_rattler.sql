ALTER TABLE "touchpoints" ADD COLUMN "dedupe_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "touchpoints" ADD CONSTRAINT "touchpoints_dedupe_key" UNIQUE("dedupe_key");