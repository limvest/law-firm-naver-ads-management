CREATE TABLE "product_lead_profiles" (
	"lead_id" uuid PRIMARY KEY NOT NULL,
	"firm_id" integer NOT NULL,
	"package_interest" text DEFAULT 'founding_pilot' NOT NULL,
	"managed_ops" boolean DEFAULT false NOT NULL,
	"budget_band" text,
	"team_size" text,
	"repeat_fraud_matters" text,
	"own_domain" text,
	"naver_account" text,
	"response_owner" text,
	"outcome_tracking" text,
	"stage" text DEFAULT 'targeted' NOT NULL,
	"follow_up_at" timestamp with time zone,
	"lost_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_lead_profiles" ADD CONSTRAINT "product_lead_profiles_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lead_profiles" ADD CONSTRAINT "product_lead_profiles_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_lead_profiles_firm_stage_updated_idx" ON "product_lead_profiles" USING btree ("firm_id","stage","updated_at");--> statement-breakpoint
CREATE INDEX "product_lead_profiles_firm_followup_idx" ON "product_lead_profiles" USING btree ("firm_id","follow_up_at");