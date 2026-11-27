ALTER TABLE "source_runs" ADD COLUMN "run_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_runs" ADD COLUMN "trigger" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_runs" ADD COLUMN "attempted" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "source_runs" ADD COLUMN "source_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_runs" ADD COLUMN "source_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_runs" ADD COLUMN "source_type" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_runs" ADD COLUMN "source_family" text;--> statement-breakpoint
ALTER TABLE "source_runs" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "source_runs" ADD COLUMN "collector_method" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_runs" ADD COLUMN "collector_config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "source_runs" AS run
SET "source_key" = source."source_key",
    "source_name" = source."name",
    "source_type" = source."source_type",
    "source_family" = source."source_family",
    "source_url" = source."base_url",
    "collector_config" = coalesce(source."config", '{}'::jsonb),
    "collector_method" = CASE coalesce(source."config"->>'type', source."source_type")
      WHEN 'google_news_rss' THEN 'google-news-rss-search'
      WHEN 'naver_cafe' THEN 'naver-cafe-public-api'
      WHEN 'naver_blog' THEN 'naver-blog-public-post-list+detail'
      WHEN 'sitemap' THEN 'sitemap-url-metadata'
      WHEN 'rss' THEN 'rss-feed'
      WHEN 'webpage' THEN 'webpage-html'
      ELSE coalesce(source."config"->>'type', source."source_type", 'unknown')
    END
FROM "intelligence_sources" AS source
WHERE source."id" = run."source_id";
