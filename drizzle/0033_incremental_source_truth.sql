ALTER TABLE "keywords" ADD COLUMN "normalized_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "keywords" ADD COLUMN "managed_by" text DEFAULT 'curated' NOT NULL;--> statement-breakpoint
ALTER TABLE "keywords" ADD COLUMN "auto_published" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "keywords"
SET "normalized_name" = regexp_replace(lower("name"), '[^0-9a-z가-힣]', '', 'g');--> statement-breakpoint
UPDATE "keywords" k
SET "managed_by" = 'competitor-sitemap'
WHERE EXISTS (
  SELECT 1 FROM "observations" o
  WHERE o."keyword_id" = k."id" AND o."source_type" = 'competitor-sitemap'
);--> statement-breakpoint
CREATE INDEX "keywords_normalized_name_idx" ON "keywords" USING btree ("normalized_name");--> statement-breakpoint

WITH ranked AS (
  SELECT id,
    first_value(id) OVER (
      PARTITION BY "keyword_id", "source_url"
      ORDER BY (facts IS NOT NULL) DESC, "observed_at" ASC, id ASC
    ) AS keep_id,
    row_number() OVER (
      PARTITION BY "keyword_id", "source_url"
      ORDER BY (facts IS NOT NULL) DESC, "observed_at" ASC, id ASC
    ) AS rn
  FROM "observations"
  WHERE "source_url" IS NOT NULL
), duplicates AS (
  SELECT id, keep_id FROM ranked WHERE rn > 1
)
UPDATE "case_entity_links" l
SET "source_observation_id" = d.keep_id
FROM duplicates d
WHERE l."source_observation_id" = d.id;--> statement-breakpoint
WITH ranked AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY "keyword_id", "source_url"
      ORDER BY (facts IS NOT NULL) DESC, "observed_at" ASC, id ASC
    ) AS rn
  FROM "observations"
  WHERE "source_url" IS NOT NULL
)
DELETE FROM "observations" o USING ranked r
WHERE o.id = r.id AND r.rn > 1;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_keyword_source_url" UNIQUE("keyword_id","source_url");--> statement-breakpoint
CREATE INDEX "observations_source_family_url_idx" ON "observations" USING btree ("source_family","source_url");--> statement-breakpoint

ALTER TABLE "source_items" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "first_seen_run_id" uuid;--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "last_seen_run_id" uuid;--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "is_current" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "parser_version" text DEFAULT 'collector-v1' NOT NULL;--> statement-breakpoint
UPDATE "source_items" i
SET "source_id" = r."source_id",
  "first_seen_run_id" = i."source_run_id",
  "last_seen_run_id" = i."source_run_id",
  "first_seen_at" = i."observed_at",
  "last_seen_at" = i."observed_at"
FROM "source_runs" r
WHERE r.id = i."source_run_id";--> statement-breakpoint
WITH ranked AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY "source_id", "source_item_key"
      ORDER BY ("case_entity_id" IS NOT NULL) DESC, "observed_at" DESC, id DESC
    ) AS rn
  FROM "source_items"
)
DELETE FROM "source_items" i USING ranked r
WHERE i.id = r.id AND r.rn > 1;--> statement-breakpoint
ALTER TABLE "source_items" ALTER COLUMN "source_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "source_items" ALTER COLUMN "first_seen_run_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "source_items" ALTER COLUMN "last_seen_run_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "source_items" DROP CONSTRAINT "source_items_run_item";--> statement-breakpoint
ALTER TABLE "source_items" ADD CONSTRAINT "source_items_source_item" UNIQUE("source_id","source_item_key");--> statement-breakpoint
ALTER TABLE "source_items" ADD CONSTRAINT "source_items_source_id_intelligence_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."intelligence_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_items" ADD CONSTRAINT "source_items_first_seen_run_id_source_runs_id_fk" FOREIGN KEY ("first_seen_run_id") REFERENCES "public"."source_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_items" ADD CONSTRAINT "source_items_last_seen_run_id_source_runs_id_fk" FOREIGN KEY ("last_seen_run_id") REFERENCES "public"."source_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_items_source_last_seen_idx" ON "source_items" USING btree ("source_id","last_seen_at");--> statement-breakpoint

CREATE TABLE "source_item_changes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_run_id" uuid NOT NULL,
  "source_item_id" uuid NOT NULL,
  "change_type" text NOT NULL,
  "previous_fingerprint" text,
  "next_fingerprint" text NOT NULL,
  "keyword_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "case_entity_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "materialized_at" timestamp with time zone,
  "processed_at" timestamp with time zone,
  CONSTRAINT "source_item_changes_run_item_fingerprint" UNIQUE("source_run_id","source_item_id","next_fingerprint")
);--> statement-breakpoint
ALTER TABLE "source_item_changes" ADD CONSTRAINT "source_item_changes_source_run_id_source_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."source_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_item_changes" ADD CONSTRAINT "source_item_changes_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_item_changes_status_created_idx" ON "source_item_changes" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "source_item_changes_item_created_idx" ON "source_item_changes" USING btree ("source_item_id","created_at");
