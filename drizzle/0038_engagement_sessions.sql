CREATE TABLE "engagement_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"session_id" text NOT NULL,
	"slug" text DEFAULT '직접 유입' NOT NULL,
	"active_seconds" integer DEFAULT 0 NOT NULL,
	"max_scroll" integer DEFAULT 0 NOT NULL,
	"page_views" integer DEFAULT 1 NOT NULL,
	"lawyer_viewed" boolean DEFAULT false NOT NULL,
	"process_viewed" boolean DEFAULT false NOT NULL,
	"contact_viewed" boolean DEFAULT false NOT NULL,
	"form_started" boolean DEFAULT false NOT NULL,
	"interest_score" integer DEFAULT 0 NOT NULL,
	"high_intent" boolean DEFAULT false NOT NULL,
	"utm" jsonb,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "engagement_sessions_firm_session_slug" UNIQUE("firm_id","session_id","slug")
);
--> statement-breakpoint
ALTER TABLE "engagement_sessions" ADD CONSTRAINT "engagement_sessions_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "engagement_sessions_firm_last_seen_idx" ON "engagement_sessions" USING btree ("firm_id","last_seen_at");
--> statement-breakpoint
CREATE INDEX "engagement_sessions_firm_slug_intent_idx" ON "engagement_sessions" USING btree ("firm_id","slug","high_intent");
