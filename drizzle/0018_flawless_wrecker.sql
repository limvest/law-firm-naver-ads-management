CREATE TABLE "ad_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"provider" text DEFAULT 'naver_searchad' NOT NULL,
	"external_customer_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"verified_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_accounts_firm_provider" UNIQUE("firm_id","provider")
);
--> statement-breakpoint
CREATE TABLE "ad_daily_stats_v2" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"ad_execution_id" uuid NOT NULL,
	"day" text NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"cost" integer DEFAULT 0 NOT NULL,
	"conversions" integer DEFAULT 0 NOT NULL,
	"qualified_leads" integer DEFAULT 0 NOT NULL,
	"retained_matters" integer DEFAULT 0 NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_daily_stats_v2_execution_day" UNIQUE("ad_execution_id","day")
);
--> statement-breakpoint
CREATE TABLE "ad_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"ad_account_id" uuid,
	"case_entity_id" uuid NOT NULL,
	"content_asset_id" uuid NOT NULL,
	"publication_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"desired_active" boolean DEFAULT false NOT NULL,
	"campaign_external_id" text,
	"ad_group_external_id" text,
	"creative_external_id" text,
	"review_status" text DEFAULT 'not_submitted' NOT NULL,
	"review_reason" text,
	"bid_amount" integer,
	"daily_budget" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_executions_firm_asset" UNIQUE("firm_id","content_asset_id")
);
--> statement-breakpoint
CREATE TABLE "ad_review_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ad_execution_id" uuid NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"raw" jsonb,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer,
	"case_entity_id" uuid,
	"content_asset_id" uuid,
	"task_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"required_actor_type" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consultations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"lead_id" uuid NOT NULL,
	"status" text DEFAULT 'booked' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer,
	"day" text NOT NULL,
	"status" text NOT NULL,
	"metrics" jsonb NOT NULL,
	"exceptions" jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_reports_firm_day" UNIQUE("firm_id","day")
);
--> statement-breakpoint
CREATE TABLE "firm_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"hostname" text NOT NULL,
	"is_canonical" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"tls_status" text DEFAULT 'pending' NOT NULL,
	"verification_error" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "firm_domains_hostname" UNIQUE("hostname")
);
--> statement-breakpoint
CREATE TABLE "firm_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"policy_version" text NOT NULL,
	"content_auto_approve" boolean DEFAULT false NOT NULL,
	"ad_auto_submit" boolean DEFAULT false NOT NULL,
	"allowed_actions" jsonb NOT NULL,
	"allowed_case_entity_ids" jsonb,
	"monthly_budget" integer,
	"daily_budget" integer,
	"bid_ceiling" integer,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "firm_policies_firm" UNIQUE("firm_id")
);
--> statement-breakpoint
CREATE TABLE "lead_qualifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"lead_id" uuid NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"actor" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_qualifications_lead" UNIQUE("lead_id")
);
--> statement-breakpoint
CREATE TABLE "lead_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"lead_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"reason" text,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matter_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"lead_id" uuid NOT NULL,
	"consultation_id" uuid,
	"status" text NOT NULL,
	"reason" text,
	"fee_band" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matter_outcomes_lead" UNIQUE("lead_id")
);
--> statement-breakpoint
CREATE TABLE "operation_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer,
	"job_id" uuid,
	"alert_type" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"message" text NOT NULL,
	"detail" jsonb,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "search_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"site_url" text NOT NULL,
	"config" jsonb,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_integrations_firm_provider_site" UNIQUE("firm_id","provider","site_url")
);
--> statement-breakpoint
CREATE TABLE "search_query_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"publication_id" uuid,
	"day" text NOT NULL,
	"query" text NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"position_basis_points" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_query_stats_integration_publication_day_query" UNIQUE("integration_id","publication_id","day","query")
);
--> statement-breakpoint
CREATE TABLE "search_url_statuses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"submitted_at" timestamp with time zone,
	"discovered_at" timestamp with time zone,
	"indexed_at" timestamp with time zone,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb,
	CONSTRAINT "search_url_statuses_integration_publication" UNIQUE("integration_id","publication_id")
);
--> statement-breakpoint
CREATE TABLE "touchpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"firm_id" integer NOT NULL,
	"case_entity_id" uuid,
	"content_asset_id" uuid,
	"publication_id" uuid,
	"ad_execution_id" uuid,
	"touch_type" text NOT NULL,
	"attribution" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visitor_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"firm_id" integer NOT NULL,
	"first_case_entity_id" uuid,
	"first_content_asset_id" uuid,
	"first_publication_id" uuid,
	"first_ad_execution_id" uuid,
	"first_touch" jsonb NOT NULL,
	"last_touch" jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "case_entity_id" uuid;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "content_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "publication_id" uuid;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "ad_execution_id" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "last_touch" jsonb;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "case_entity_id" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "content_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "publication_id" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "ad_execution_id" uuid;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_daily_stats_v2" ADD CONSTRAINT "ad_daily_stats_v2_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_daily_stats_v2" ADD CONSTRAINT "ad_daily_stats_v2_ad_execution_id_ad_executions_id_fk" FOREIGN KEY ("ad_execution_id") REFERENCES "public"."ad_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_executions" ADD CONSTRAINT "ad_executions_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_executions" ADD CONSTRAINT "ad_executions_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_executions" ADD CONSTRAINT "ad_executions_case_entity_id_case_entities_id_fk" FOREIGN KEY ("case_entity_id") REFERENCES "public"."case_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_executions" ADD CONSTRAINT "ad_executions_content_asset_id_content_assets_id_fk" FOREIGN KEY ("content_asset_id") REFERENCES "public"."content_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_executions" ADD CONSTRAINT "ad_executions_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_review_events" ADD CONSTRAINT "ad_review_events_ad_execution_id_ad_executions_id_fk" FOREIGN KEY ("ad_execution_id") REFERENCES "public"."ad_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_tasks" ADD CONSTRAINT "approval_tasks_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_tasks" ADD CONSTRAINT "approval_tasks_case_entity_id_case_entities_id_fk" FOREIGN KEY ("case_entity_id") REFERENCES "public"."case_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_tasks" ADD CONSTRAINT "approval_tasks_content_asset_id_content_assets_id_fk" FOREIGN KEY ("content_asset_id") REFERENCES "public"."content_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_domains" ADD CONSTRAINT "firm_domains_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_policies" ADD CONSTRAINT "firm_policies_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_qualifications" ADD CONSTRAINT "lead_qualifications_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_qualifications" ADD CONSTRAINT "lead_qualifications_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_status_history" ADD CONSTRAINT "lead_status_history_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_status_history" ADD CONSTRAINT "lead_status_history_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_outcomes" ADD CONSTRAINT "matter_outcomes_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_outcomes" ADD CONSTRAINT "matter_outcomes_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_outcomes" ADD CONSTRAINT "matter_outcomes_consultation_id_consultations_id_fk" FOREIGN KEY ("consultation_id") REFERENCES "public"."consultations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_alerts" ADD CONSTRAINT "operation_alerts_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_alerts" ADD CONSTRAINT "operation_alerts_job_id_operation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."operation_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_integrations" ADD CONSTRAINT "search_integrations_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_query_stats" ADD CONSTRAINT "search_query_stats_integration_id_search_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."search_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_query_stats" ADD CONSTRAINT "search_query_stats_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_url_statuses" ADD CONSTRAINT "search_url_statuses_integration_id_search_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."search_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_url_statuses" ADD CONSTRAINT "search_url_statuses_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "touchpoints" ADD CONSTRAINT "touchpoints_session_id_visitor_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."visitor_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "touchpoints" ADD CONSTRAINT "touchpoints_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "touchpoints" ADD CONSTRAINT "touchpoints_case_entity_id_case_entities_id_fk" FOREIGN KEY ("case_entity_id") REFERENCES "public"."case_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "touchpoints" ADD CONSTRAINT "touchpoints_content_asset_id_content_assets_id_fk" FOREIGN KEY ("content_asset_id") REFERENCES "public"."content_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "touchpoints" ADD CONSTRAINT "touchpoints_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "touchpoints" ADD CONSTRAINT "touchpoints_ad_execution_id_ad_executions_id_fk" FOREIGN KEY ("ad_execution_id") REFERENCES "public"."ad_executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "visitor_sessions_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "visitor_sessions_first_case_entity_id_case_entities_id_fk" FOREIGN KEY ("first_case_entity_id") REFERENCES "public"."case_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "visitor_sessions_first_content_asset_id_content_assets_id_fk" FOREIGN KEY ("first_content_asset_id") REFERENCES "public"."content_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "visitor_sessions_first_publication_id_publications_id_fk" FOREIGN KEY ("first_publication_id") REFERENCES "public"."publications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "visitor_sessions_first_ad_execution_id_ad_executions_id_fk" FOREIGN KEY ("first_ad_execution_id") REFERENCES "public"."ad_executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_daily_stats_v2_firm_day_idx" ON "ad_daily_stats_v2" USING btree ("firm_id","day");--> statement-breakpoint
CREATE INDEX "ad_executions_firm_status_idx" ON "ad_executions" USING btree ("firm_id","status");--> statement-breakpoint
CREATE INDEX "ad_review_events_execution_observed_idx" ON "ad_review_events" USING btree ("ad_execution_id","observed_at");--> statement-breakpoint
CREATE INDEX "approval_tasks_firm_status_idx" ON "approval_tasks" USING btree ("firm_id","status");--> statement-breakpoint
CREATE INDEX "consultations_firm_status_idx" ON "consultations" USING btree ("firm_id","status");--> statement-breakpoint
CREATE INDEX "firm_domains_firm_status_idx" ON "firm_domains" USING btree ("firm_id","status");--> statement-breakpoint
CREATE INDEX "lead_qualifications_firm_status_idx" ON "lead_qualifications" USING btree ("firm_id","status");--> statement-breakpoint
CREATE INDEX "lead_status_history_lead_created_idx" ON "lead_status_history" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE INDEX "matter_outcomes_firm_status_idx" ON "matter_outcomes" USING btree ("firm_id","status");--> statement-breakpoint
CREATE INDEX "operation_alerts_status_severity_idx" ON "operation_alerts" USING btree ("status","severity");--> statement-breakpoint
CREATE INDEX "search_query_stats_publication_day_idx" ON "search_query_stats" USING btree ("publication_id","day");--> statement-breakpoint
CREATE INDEX "search_url_statuses_status_checked_idx" ON "search_url_statuses" USING btree ("status","checked_at");--> statement-breakpoint
CREATE INDEX "touchpoints_firm_occurred_idx" ON "touchpoints" USING btree ("firm_id","occurred_at");--> statement-breakpoint
CREATE INDEX "touchpoints_session_occurred_idx" ON "touchpoints" USING btree ("session_id","occurred_at");--> statement-breakpoint
CREATE INDEX "visitor_sessions_firm_last_seen_idx" ON "visitor_sessions" USING btree ("firm_id","last_seen_at");